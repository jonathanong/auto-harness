# REST API

HTTP API for sessions, repositories, auth, schedules, and agents. Served at `/api/v1` via API Gateway + Lambda.

## Session usage and configured cost

Hosts may report provider-neutral usage only when a CLI adapter emits an authoritative usage
record. Prompts and log chunks are never inspected for token counts or cost. Reports carry
`kind` (`cumulative` or `delta`), a monotonic per-attempt `sequence`, decimal-string counters,
and optional operator-configured `costMicros`/ISO currency. The control plane attributes each
accepted report from the durable session route to its repository, provider, Provider Account, and
Command; host-supplied attribution is ignored. Old attempt IDs and replaced host connections are
discarded.

`GET /api/v1/sessions/:id/usage` returns report detail plus an aggregate. Repository-scoped
`GET /api/v1/usage?repositoryId=...` supports optional `providerId`, `providerAccountId`, and
`commandId` filters. Access is repository-scoped and every successful report read is audited.
Duplicate sequence reports are idempotent and out-of-order reports are safe. A durable per-attempt
kind marker rejects mixing cumulative and delta reports; aggregate costs are grouped in
`costMicrosByCurrency` so currencies are never added together. Provider `usageRates` are optional
operator configuration only; Auto Harness does not fetch vendor prices or implement billing.

Live streaming and agent control use the [WebSocket protocol](websocket.md). Credentials: [auth.md](auth.md). Deploy: [setup.md](setup.md). Local stack: [local-development.md](local-development.md).

**Phase 2+ fields on `POST /sessions`:** `ref` (a branch, tag, or SHA), a `target` plus ordered `fallbacks` (never a free-form `command`), `queueTtlSeconds`, an optional global exact-match `concurrencyId`, and `metadata`; response includes UI `url` and route labels. Provider targets use the provider's eligible account pool; providerless Commands (`providerId: null`) run ungated. Scheduled sessions run on the repository main checkout only when the host advertises the required capability. Resume pins **agent only** (D5). List search is client-side only (no DynamoDB full-text).

Queued assignment is globally ordered by priority (descending) then `createdAt`/`id` FIFO across all queue shards — a later shard's higher-priority session is never starved by draining shard 0 first. Prompt and scheduled assignment and UI `GET /session-targets` availability share one evaluator; DynamoDB conditional writes remain the final claim. Prompt and scheduled queued sessions both fail `queue_expired` at their original `queueExpiresAt` and release their `concurrencyId` lock. A providerless `usage_limit` suppresses the failed target, immediately tries the next fallback, and waits only until that original queue deadline.

`concurrencyId` is an exact, caller-chosen idempotency/concurrency identity shared by manual and scheduled creates. Its UTF-8 length is at most 2,048 bytes, including a schedule's derived `schedule-${scheduleId}` default; oversized session or schedule writes and exact-list filters return `400 VALIDATION_ERROR`. While its lock is held, a repeated create returns `200 OK` with the existing session and `created: false`; a new identity returns `201 Created` with `created: true`. A terminal session releases its lock, so a later request may retry with the same id. The lock is durable and atomic across API workers.

**CI / repo harness:** create sessions with `POST /sessions` (or `/resume`) and **return immediately** — fire and forget. Do not hold the caller open for session completion; humans watch [Slack](integrations.md) and GitHub. The stable automation subset is described by [OpenAPI](openapi.yaml); packaged integrations and patterns are in [harness.md](harness.md).

## Audit logs

`GET /audit-logs` is available only to authenticated admins. It returns an
append-only audit page:

```json
{
  "items": [
    {
      "id": "audit-…",
      "actor": { "id": "user:alice", "kind": "user", "role": "admin" },
      "action": "repository:update",
      "resourceType": "repository",
      "resourceId": "repo-1",
      "outcome": "success",
      "createdAt": "2026-08-10T00:00:00.000Z",
      "metadata": {}
    }
  ],
  "nextCursor": "opaque-when-more-results-exist"
}
```

Optional exact-match filters are `actorId`, `action`, `resourceType`,
`resourceId`, `repositoryId`, and `outcome` (`success`, `denied`, or `failed`).
`limit` is 1–100 and defaults to 50. Audit records have no update or delete
endpoint. Metadata never includes passwords, API keys, tokens, integration
secrets, prompts, or session-log content.

## Authentication

| Method         | Format                               | Used by                        |
| -------------- | ------------------------------------ | ------------------------------ |
| Session cookie | `Cookie: auto_harness_session=<jwt>` | Web UI                         |
| Bearer token   | `Authorization: Bearer hns_…`        | Service accounts (CI, scripts) |
| Basic auth     | `Authorization: Basic …`             | Admin / user direct API calls  |

`401` if missing/invalid; `403` if role insufficient. Role and capability
matrix: [roles.md](roles.md).

### `POST /auth/viewer-ticket`

Issue a 60-second, one-time browser WebSocket credential from an authenticated admin or user session (cookie or Basic auth). The response is `{ ticket }` with `Cache-Control: no-store`. The browser presents it only as the `ticket` query parameter on `/ws/viewer`, which consumes it. When authentication is required, that socket does not accept the session cookie. Service-account credentials cannot mint a ticket and are never accepted by the socket.

---

## Conventions

Base path: `/api/v1`

### Error Responses

All errors return a consistent JSON body:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "repositoryId is required"
  }
}
```

| Status | Code                          | Description                                                  |
| ------ | ----------------------------- | ------------------------------------------------------------ |
| 400    | `VALIDATION_ERROR`            | Invalid or missing request body fields                       |
| 401    | `UNAUTHORIZED`                | Missing or invalid token                                     |
| 403    | `FORBIDDEN`                   | Insufficient role permissions                                |
| 404    | `NOT_FOUND`                   | Resource not found                                           |
| 409    | `CONFLICT`                    | Resource conflict (e.g. duplicate name)                      |
| 409    | `DRAINING`                    | This principal/repository scope is fenced by a session drain |
| 409    | `REPOSITORY_ADMISSION_CLOSED` | Repository is paused or draining                             |
| 429    | `RATE_LIMITED`                | Too many requests; see `Retry-After`                         |
| 500    | `INTERNAL_ERROR`              | Unexpected server error                                      |

Rate limit headers on all responses:

- `X-RateLimit-Limit`
- `X-RateLimit-Remaining`
- `X-RateLimit-Reset`

When a bucket is exhausted, the response is `429` with
`{"error":{"code":"RATE_LIMITED","message":"too many requests"}}` and a
`Retry-After` header containing the number of seconds until the fixed window
resets. A temporary failure reaching durable rate-limit storage is `503`
`RATE_LIMIT_UNAVAILABLE` under the default fail-closed policy.

---

## Repository admission

Repository records expose `admissionState`: `active`, `paused`, or `draining`. A missing state on
a legacy row means `active`.

- `POST /repositories/:id/pause` closes admission immediately. New create, clone, resume, manual
  schedule trigger, cron fire, and assignment attempts return or observe
  `409 REPOSITORY_ADMISSION_CLOSED`; already-running sessions continue.
- `POST /repositories/:id/drain` closes admission and cancels every queued or running session.
  The state remains `draining` while an agent still owns a worktree or main-checkout lease, then
  the scheduler settles it to `paused`.
- `POST /repositories/:id/activate` reopens admission. It returns `409 CONFLICT` until a drain has
  completely released its leases.

Paused or draining cron schedules advance to their next future occurrence without catch-up when
the repository is activated. These operations require `repositories:operate` and are audited.

### Principal session drains

Cancels the authenticated principal's own queued and running sessions for one repository, then
fences new admission from that same principal until the fence is explicitly released. This is
**not** repository drain (above; operator-triggered, cancels every principal's sessions) or host
update drain (one host, running work finishes) — the fence is `(repositoryId, principal)` only, so
it never touches another principal's sessions or another repository's sessions. It does not
distinguish by how a session was started: a UI-started session owned by the calling principal is
in scope just like an API- or webhook-started one.

- `POST /repositories/:id/session-drains` commits the exact
  `(repositoryId, authenticated principal)` admission fence and returns `202` with
  `operationId`, `status`, and `statusUrl`. Send a stable `Idempotency-Key` (1–128 characters from
  `A-Z a-z 0-9 . _ : -`) so an ambiguous retry returns the same retained operation even after
  release or an API restart.
- `GET /repositories/:id/session-drains/:operationId` reconciles one bounded activity page and returns counts plus
  `draining`, `succeeded`, or `failed`. The scheduler continues reconciliation when nobody polls.
  `succeeded` is durable proof that the exact scope has no queued/running session and no cancelled
  session still holding a worktree or main-checkout lease.
- `POST /repositories/:id/session-drains/:operationId/release` explicitly removes the fence after
  either terminal result. Releasing `failed` permits new admission but does not change the retained
  operation proof to success.

While fenced, direct create, clone, resume, schedule fire, and assignment fail atomically with
`409 DRAINING`; the error includes the operation ID and status URL. Running work receives the
normal fenced `session:cancel` message and remains part of progress until its exact lease is
released. Prompts, logs, metadata, and credentials never enter drain progress or audit metadata.

The `session-drain:create` audit event is committed in the same DynamoDB transaction as the
`CURRENT` fence and retained `OP#operationId` record, using an operation-derived audit ID. Terminal
`session-drain:succeeded` and `session-drain:failed` events are likewise committed with the terminal
state transition. Retries and concurrent reconcilers therefore retain exactly one creation and one
terminal audit record; creation preserves the authenticated caller as actor, while terminal events
use the system actor. Release is coupled to its audit record too, so a later audit failure cannot
hide an already-committed drain operation behind an erroneous HTTP failure.

Drain completion is proved from a strongly consistent activity ledger: each principal-owned
session writes an `ACT#sessionId` member in its `(repository, principal)` partition in the same
transaction as admission and the drain fence, then reconciliation strongly reads that bounded
partition and each exact session row. It never infers quiescence from an eventually consistent
secondary index. On the first deployment that enables this ledger, the scheduler performs a
fenced, resumable, strongly consistent backfill of active owned sessions in bounded pages before
writing its readiness marker; REST and WebSocket cold starts never perform this scan, and drain
requests fail closed until the marker exists. Roll upgrades must retire all older control-plane
writers before enabling the scheduler bootstrap, since an old binary could otherwise admit an
untracked session during the migration.

Durable schedules have an authenticated owner. Legacy schedules created before ownership was
persisted are deliberately inert: durable manual trigger and cron do not mint sessions, and cron
consumes each due occurrence with an operator-visible audit event until an authenticated,
repository-scoped schedule edit claims ownership for that principal. The owner is derived from
authentication and cannot be supplied in schedule JSON.

It requires `sessions:write`; repository scope and principal ownership are always derived from
authentication and cannot be supplied in the request.

---

### Auth — Login

#### `POST /auth/login`

Authenticate as a human user (admin or user account). Returns a session cookie.

**Request:**

```json
{
  "username": "jong",
  "password": "my-password"
}
```

**Response:** `200 OK` + `Set-Cookie: auto_harness_session=<jwt>`

```json
{
  "username": "jong",
  "role": "operator"
}
```

The server checks `HARNESS_ADMINS` env var first, then DynamoDB user records. On success, sets an `HttpOnly`, `Secure`, `SameSite=Strict` session cookie (24h expiry).

#### `POST /auth/logout`

Clear the session cookie.

**Response:** `204 No Content` + `Set-Cookie: auto_harness_session=; Max-Age=0`

#### `GET /auth/me`

Get the current authenticated user's info.

**Response:** `200 OK`

```json
{
  "id": "user:jong",
  "username": "jong",
  "role": "operator",
  "kind": "user"
}
```

The `kind` field is `admin` (env var), `user` (DynamoDB), or `service-account`.

#### `PUT /auth/password`

Change the current user's password. Not available for admin accounts (rotate via env var) or service accounts.

**Request:**

```json
{
  "currentPassword": "old-password",
  "newPassword": "new-password"
}
```

**Response:** `200 OK`

---

### Auth — User Accounts

#### `POST /auth/users`

Create a user account. **Admin only.**

**Request:**

```json
{
  "username": "jong",
  "password": "initial-password",
  "role": "operator"
}
```

**Response:** `201 Created`

```json
{
  "id": "usr-e5f6g7h8",
  "username": "jong",
  "role": "operator",
  "createdAt": "2026-08-01T00:00:00Z"
}
```

#### `GET /auth/users`

List all user accounts. **Admin only.**

#### `DELETE /auth/users/:id`

Delete a user account. **Admin only.**

**Response:** `204 No Content`

---

### Auth — Service Accounts

#### `POST /auth/service-accounts`

Create a service account. **Admin only.**

**Request:**

```json
{
  "name": "ci-frontend",
  "role": "operator",
  "allowedRepositories": ["repo-abc"],
  "boundHostId": "vps-prod-1"
}
```

| Field                 | Type     | Required | Description                                                                                                              |
| --------------------- | -------- | -------- | ------------------------------------------------------------------------------------------------------------------------ |
| `name`                | string   | ✓        | Human-readable name                                                                                                      |
| `role`                | string   | ✓        | `read-only`, `author`, `operator`, `maintainer`, `agent`, or `admin`                                                     |
| `allowedRepositories` | string[] | ✗        | Restrict to specific repos. Default: all repos.                                                                          |
| `boundHostId`         | string   | ✗        | Required for agent service accounts. Binds this key to a specific agent identity (see [auth.md](auth.md#agent-binding)). |

**Response:** `201 Created`

```json
{
  "account": {
    "id": "service:a1b2c3d4",
    "name": "ci-frontend",
    "username": "ci-frontend",
    "kind": "service-account",
    "role": "operator",
    "allowedRepositoryIds": ["repo-abc"],
    "createdAt": "2026-08-01T00:00:00Z"
  },
  "apiKey": "hns_k8f2m9x..."
}
```

> **Note:** The `apiKey` is returned only once. Store it securely.

#### `GET /auth/service-accounts`

List all service accounts. **Admin only.**

**Response:** `200 OK`

```json
{
  "items": [
    {
      "id": "service:a1b2c3d4",
      "name": "ci-frontend",
      "username": "ci-frontend",
      "kind": "service-account",
      "role": "operator",
      "allowedRepositoryIds": ["repo-abc"],
      "createdAt": "2026-08-01T00:00:00Z"
    }
  ]
}
```

#### `DELETE /auth/service-accounts/:id`

Delete a service account and revoke its API key. **Admin only.**

**Response:** `204 No Content`

---

### Integrations — Slack

Slack configuration is the singleton `/integrations/slack`. Every method
requires an unscoped **admin** account; operators, read-only users, and
repository- or host-scoped admins receive `403`.

`POST` creates and `PUT` replaces the configuration. Both require a complete
body, including the `xoxb-…` bot token and a channel name (such as `#harness`)
or Slack channel ID. `enabled`, notification toggles, and an optional signing
secret are supported. `GET` returns no token, signing secret, or ciphertext:
only `botTokenConfigured`, `signingSecretConfigured`, and `deliveryAvailable`
flags. `DELETE` returns `204`. `deliveryAvailable` is `true` only when this
environment can decrypt the bot token and run the outbound worker; otherwise
the control plane reports configured-but-unavailable and does not imply that
messages will be sent.

KMS encrypts the secret fields with `KMS_KEY_ID` and the stable
`auto-harness/slack-integration` / `slack` encryption context before the
configuration reaches DynamoDB. Missing KMS configuration or an encryption
failure fails the write closed. Configuration writes use a durable version so a
stale worker receives `409 CONFLICT`, rather than overwriting another worker.
All create, update, delete, validation, and storage outcomes are audit events;
the request body and secret values are never passed to audit metadata.

Outbound session-thread delivery uses `chat.postMessage` / `chat.update` through
the leased outbox. Session create/cancel/complete writers enqueue lifecycle rows
in the REST/WS/cron process that persisted the snapshot, so a session that is
created and cancelled between ticks is still delivered. The local server starts
the worker when storage plus an injected transport or secret encryptor exist;
the deployed cron Lambda drains the same outbox. GET may decrypt the bot token
as a capability probe for `deliveryAvailable`. Delivery is at-least-once across
Lambda invocations.
Retries use the existing attempt ceiling and dead-letter exhausted operations.
This endpoint does not implement Slack OAuth or incoming event verification.

---

### Repositories

#### `POST /repositories`

Add a repository. **Admin only.**

**Request:**

```json
{
  "name": "my-app",
  "url": "git@github.com:org/my-app.git",
  "defaultBranch": "main",
  "setupScript": "./ci/session-setup"
}
```

**Response:** `201 Created`

```json
{
  "id": "repo-abc",
  "name": "my-app",
  "url": "git@github.com:org/my-app.git",
  "defaultBranch": "main",
  "setupScript": "./ci/session-setup",
  "createdAt": "2026-08-01T00:00:00Z"
}
```

#### `GET /repositories`

List a bounded page of repositories visible to the authenticated principal. The continuation cursor
owns traversal order; clients that present a full catalog should collect every page before applying
their own display sorting.

**Query parameters:**

| Param    | Type   | Description                                      |
| -------- | ------ | ------------------------------------------------ |
| `limit`  | number | Base-10 integer from 1 to 100 (default: 50)      |
| `cursor` | string | Opaque cursor returned by the preceding response |

Repository visibility is applied before the page limit, so hidden repositories never consume a
page slot. `nextCursor` is signed and bound to the caller's repository scope; malformed, tampered,
or scope-mismatched cursors and invalid or duplicate parameters return structured
`400 VALIDATION_ERROR` responses.

**Response:** `200 OK`

```json
{
  "items": [
    {
      "id": "repo-abc",
      "name": "my-app",
      "url": "git@github.com:org/my-app.git",
      "defaultBranch": "main",
      "sessionCount": 12,
      "worktreeCount": 3,
      "scheduleCount": 2,
      "createdAt": "2026-08-01T00:00:00Z"
    }
  ],
  "nextCursor": "eyJ..."
}
```

`nextCursor` is an opaque cursor when more repositories are available, or `null` on the final
page. Visibility filtering is applied before `limit`; cursors are bound to the caller's repository
scope and cannot be reused with a different scope. Invalid or repeated query parameters return a
structured `400`.

The three count fields are durable, index-backed totals for each repository visible to the
authenticated principal. Host-bound credentials receive session and worktree totals for their host.
Session, worktree, and schedule totals can briefly lag a just-committed write while DynamoDB
propagates their repository indexes. During an index creation/backfill, one strongly consistent
table scan supplies the affected count family for the whole repository page; normal indexed reads
resume as soon as DynamoDB makes the index queryable. `nextCursor` is `null` on the final page.
Callers that require the complete visible catalog must continue until then; every individual
response remains capped at 100 repositories.

#### `GET /repositories/:id`

Get repository details.

#### `PUT /repositories/:id`

Update a repository. **Admin only.**

#### `DELETE /repositories/:id`

Delete a repository. **Admin only.** Deletion returns `409 CONFLICT` while a schedule,
queued/running session, worktree, or host inventory still references it. The error includes the
blocking `{ kind, id, status? }` dependencies; deletion never cascades.

---

### Sessions

#### `POST /sessions`

Create a new session. This is the main endpoint for triggering AI work. **Operator or
admin — and the principal must NOT have `boundHostId` set.** A bound service account
(the kind a host daemon uses) gets `404 {"error":{"code":"NOT_FOUND","message":"resource
not found"}}` here, confirmed against a real deployment — deliberately not `403`, and
with no mention of `boundHostId` in the response. See
[auth.md#a-bound-key-cannot-create-sessions](auth.md#a-bound-key-cannot-create-sessions).
A host needs two service accounts: one bound (for `HARNESS_API_KEY` on the daemon) and
one unbound (for anything that creates sessions).

**Request:**

```json
{
  "repositoryId": "repo-abc",
  "prompt": "Fix the failing test in src/utils.test.ts",
  "ref": "feature/fix-utils",
  "target": { "providerId": "prov-codex" },
  "fallbacks": [{ "commandId": "cmd-echo" }],
  "queueTtlSeconds": 691200,
  "timeout": 1800,
  "priority": 10,
  "requiredLabels": ["codex"],
  "concurrencyId": "filaments:shepherd:123",
  "metadata": { "pullRequest": 123 },
  "source": "ui"
}
```

| Field             | Type     | Required | Description                                                                                                                                                            |
| ----------------- | -------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repositoryId`    | string   | ✓        | Target repository                                                                                                                                                      |
| `prompt`          | string   | ✓        | The prompt/instruction for the AI agent. UTF-8 length is at most 65,536 bytes; 65,537 is `400 VALIDATION_ERROR`.                                                       |
| `ref`             | string   | ✗        | Branch, tag, or commit SHA to check out. The repository default branch is used when omitted.                                                                           |
| `target`          | object   | ✓        | Primary `{ providerId }` or `{ commandId }` target. Provider targets use the provider's eligible account pool; providerless Commands (`providerId: null`) run ungated. |
| `fallbacks`       | object[] | ✗        | Ordered additional targets. The scheduler advances only when the preceding target has no eligible route.                                                               |
| `queueTtlSeconds` | number   | ✗        | Absolute queue lifetime, default `691200` (8 days). Expiry reports `queue_expired`; fallback attempts do not reset it.                                                 |
| `timeout`         | number   | ✓        | Max session duration in seconds. The agent kills the process after this time.                                                                                          |
| `priority`        | number   | ✗        | Higher = more urgent. Default: `0`                                                                                                                                     |
| `requiredLabels`  | string[] | ✗        | Worktree labels required. Default: `[]` (any worktree)                                                                                                                 |
| `source`          | string   | ✗        | Origin of the session: `api`, `ui`, `webhook`, `schedule`. Default: `api`                                                                                              |
| `type`            | string   | ✗        | Session type: `prompt` (runs in worktree) or `scheduled` (runs on main checkout). Default: `prompt`                                                                    |
| `concurrencyId`   | string   | ✗        | Global exact-match identity, at most 2,048 UTF-8 bytes. An active duplicate returns the existing session (`200`, `created: false`); terminal sessions release it.      |
| `metadata`        | object   | ✗        | Caller-supplied, non-secret provenance carried with the session.                                                                                                       |

Unknown target/fallback IDs, duplicate route references, or malformed target objects are rejected `400` at create time.

> **Note:** The Web UI uses this same endpoint to create sessions directly from the browser. The UI provides repo/prompt controls, a primary target picker, ordered fallback controls, queue TTL, timeout, priority, labels, and route/queue status in session details.

**Response:** `201 Created` for a new session (`created: true`), or `200 OK` when an active matching `concurrencyId` returns the existing session (`created: false`).

```json
{
  "id": "sess-x1y2z3",
  "repositoryId": "repo-abc",
  "prompt": "Fix the failing test in src/utils.test.ts",
  "target": { "providerId": "prov-codex" },
  "fallbacks": [{ "commandId": "cmd-echo" }],
  "queueExpiresAt": "2026-08-09T12:00:00Z",
  "targetDisplayNames": ["codex", "echo"],
  "status": "queued",
  "timeout": 1800,
  "priority": 10,
  "requiredLabels": ["codex"],
  "concurrencyId": "filaments:shepherd:123",
  "url": "http://127.0.0.1:7421/sessions/sess-x1y2z3",
  "created": true,
  "source": "ui",
  "type": "prompt",
  "createdAt": "2026-08-01T12:00:00Z"
}
```

`targetDisplayNames` is the human-readable primary-plus-fallback list fixed at create: a provider target stores the provider name, a provider-backed command stores `"<provider> — <command>"`, and a providerless command stores the command name. Account labels are not included; account selection happens at assignment. Requested provider identity is `target.providerId`, not a top-level `providerId`. Once assigned, the session also gains `resolvedArgv` and `resolvedRoute` (including optional `providerAccountId`); there is no top-level `providerAccountId`.

The session enters the `queued` state. Assignment is attempted immediately as a best-effort side effect of create, resume, clone, host register/reconnect, terminal transitions, and capacity or cooldown changes. The one-minute EventBridge/local cron is a repair sweep (ack deadlines, running timeouts, stale hosts, and any missed assigns), not the primary dispatcher. If multiple worktrees match, assignment is **round-robin** (least recently assigned first). If none are available, the session remains queued until capacity appears or `queueExpiresAt`. The planner uses advertised host-wide `maxConcurrentAssignments` and per-account execution-profile readiness; daemons still fail closed if a late assign exceeds local capacity.

If the session exceeds `timeout` seconds while running, the agent kills the process and reports `timed_out`. The control plane also terminates an acknowledged `running` assignment at `ackReceivedAt + timeout` if that host report is lost or rejected. The EventBridge/local scheduler applies the bound on the next sweep after that deadline (typically within 60 seconds).

If a provider-aware CLI adapter validates an **AI vendor usage/rate-limit** signal from a structured
result, the agent reports `errorCode: "usage_limit"`. The control plane pauses the assigned Provider
Account globally for its configured cooldown (default 5 hours), releases the worktree, and
immediately tries the next eligible account or fallback. Providerless and non-structured commands
do not pause an account. See [host-daemon.md — Usage limits](host-daemon.md#usage-limits-ai-vendor--cli-quotas).

The concurrency identity is released for terminal states (`completed`, `failed`, `cancelled`, `timed_out`), allowing an explicit retry with the same id. A manual duplicate while the original is queued or running is deduplicated and returns the original session; it never creates a second queued run.

#### `GET /sessions`

List sessions with optional filters.

**Query parameters:**

| Param           | Type   | Description                                                                                                |
| --------------- | ------ | ---------------------------------------------------------------------------------------------------------- |
| `status`        | string | Filter by status, or `all` (default): `queued`, `running`, `completed`, `failed`, `cancelled`, `timed_out` |
| `repositoryId`  | string | Filter by repository                                                                                       |
| `hostId`        | string | Filter by assigned host                                                                                    |
| `source`        | string | Filter by origin: `api`, `ui`, `webhook`, or `schedule`                                                    |
| `sort`          | string | Sort order: `latest` (default), `oldest`, `priority_desc`, `priority_asc`                                  |
| `limit`         | number | Base-10 integer from 1 to 100 (default: 50)                                                                |
| `cursor`        | string | Pagination cursor from previous response                                                                   |
| `concurrencyId` | string | Exact concurrency identity, at most 2,048 UTF-8 bytes (may span schedules and manual sessions)             |
| `scheduleId`    | string | Exact schedule provenance; used for one schedule's run history                                             |

Results are scoped to the authenticated principal's allowed repositories and host binding
before the `limit` is applied. `nextCursor` is an opaque, signed cursor bound to all filters,
sort order, and principal scope; changing or tampering with those values returns `400`. Invalid
limits, statuses, sources, empty filter values, and duplicate filter parameters return a structured `400`.

For multi-worker deployments, set `HARNESS_CURSOR_SECRET` to the same stable secret on every API
worker (or use the existing shared `HARNESS_SESSION_SECRET` as its fallback). The secret signs both
session-list and repository-list cursors. If neither variable is set, a random process-local secret
is used; cursors from that fallback are valid only in the same local-memory process and must not be
used for a distributed deployment. Lambda mode always supplies a stable secret explicitly — every
worker fetches the same value from the
`HARNESS_CURSOR_SECRET_SSM_PARAM`-named SSM parameter at cold start
([deploy-aws.md](deploy-aws.md#secrets-and-config-never-commit)) — so the random fallback never
applies there.

**Response:** `200 OK`

```json
{
  "items": [...],
  "nextCursor": "eyJ..."
}
```

#### `GET /sessions/:id`

Get session details.

**Response:** `200 OK`

```json
{
  "id": "sess-x1y2z3",
  "repositoryId": "repo-abc",
  "worktreeId": "wt-1",
  "userId": "sa-a1b2c3d4",
  "prompt": "Fix the failing test in src/utils.test.ts",
  "target": { "providerId": "prov-codex" },
  "fallbacks": [{ "commandId": "cmd-echo" }],
  "targetDisplayNames": ["codex", "echo"],
  "status": "running",
  "type": "prompt",
  "source": "ui",
  "timeout": 1800,
  "priority": 10,
  "hostId": "vps-prod-1",
  "requiredLabels": ["codex"],
  "exitCode": null,
  "errorCode": null,
  "errorMessage": null,
  "resumedFromSessionId": null,
  "pinnedHostId": null,
  "pinExpiresAt": null,
  "cliResumeRef": null,
  "queueExpiresAt": "2026-08-09T12:00:00Z",
  "resolvedRoute": {
    "targetIndex": 0,
    "providerAccountId": "acct-codex-1",
    "commandId": "cmd-codex-fix",
    "hostId": "vps-prod-1",
    "worktreeId": "wt-1",
    "attemptId": "att-1"
  },
  "createdAt": "2026-08-01T12:00:00Z",
  "startedAt": "2026-08-01T12:00:05Z",
  "completedAt": null
}
```

| Field                           | When set                                                                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `hostId` / `worktreeId`         | Set when assigned; the recorded Host and Worktree are included in route diagnostics                                             |
| `errorCode`                     | Optional machine-readable failure reason, e.g. `usage_limit` or `queue_expired`                                                 |
| `errorMessage`                  | Optional short human excerpt from the match / logs (Git excerpts are bounded and redact credentials)                            |
| `resumedFromSessionId`          | Set on sessions created via resume — parent session id                                                                          |
| `pinnedHostId` / `pinExpiresAt` | Temporary host-only native-resume preference and deadline; cleared before fresh fallback routing                                |
| `cliResumeRef`                  | Optional opaque id from the AI CLI for native resume; discarded when falling back to a fresh route                              |
| `queueExpiresAt`                | Fixed absolute queue deadline; fallback attempts never extend it                                                                |
| `resolvedRoute`                 | Last assigned route: `targetIndex`, optional `providerAccountId`, `commandId`, `hostId`, `worktreeId`, `attemptId` (no secrets) |

#### `POST /sessions/:id/clone`

Clone a session as a clean, independent rerun. The response always
contains a **new** session id and is `201 Created`. Assignment uses normal
**label match + round-robin** (any eligible worktree). **Operator or admin.**

The clone snapshots only replayable session inputs: `repositoryId`, `prompt`,
the target/fallback chain, `queueTtlSeconds`, `timeout`, `priority`,
`requiredLabels`, and `ref`. It starts as `queued`, with a fresh queue deadline,
`type: "prompt"`, and `source: "api"`. `concurrencyId` is deliberately not
copied, so a clone never deduplicates against or replaces its source.

Runtime state is never copied: host/worktree placement or leases, assignment
fences, resolved argv/route, resume pins or CLI references, status timestamps,
logs, schedule provenance, session metadata, and credentials/secrets. The
authenticated actor id is recorded as the new session's `metadata.createdBy`
(when authentication is enabled).

Optional request body to override fields:

```json
{
  "prompt": "Updated prompt text",
  "priority": 20
}
```

Only `prompt`, `timeout`, and `priority` may be overridden. The source may be
queued, running, or terminal because no runtime state is copied. Repository
authorization is checked against the source repository.

**Errors:** `404 NOT_FOUND` for an unknown or unauthorized source, `400
VALIDATION_ERROR` for malformed JSON or unsupported/invalid overrides, `409
CONFLICT` for a durable create conflict that requires retry, and `500
INTERNAL_ERROR` when durable state cannot be read or persisted.

**Response:** `201 Created` (same schema as `POST /sessions` response)

#### `POST /sessions/:id/resume`

Resume work from a prior session. Pass the **session id** in the path. Native resume pins to the
source host and command/account route, but may use another eligible worktree for the same
repository and `ref`. If that route is unavailable, the control plane clears the native reference
and placement pin, then routes a fresh run through the configured target/fallback chain.

**Operator or admin.** Source session must have been assigned at least once (`hostId` + `worktreeId` recorded). Typically used on terminal sessions (`completed`, `failed`, `cancelled`, `timed_out`) or after a controlled stop — not while the source is still `running`.

**Request (optional body):**

```json
{
  "prompt": "Continue: also fix the edge case in parseDate",
  "concurrencyId": "filaments:shepherd:123",
  "timeout": 1800,
  "priority": 10
}
```

| Field           | Type   | Required | Description                                                                                                                                                                                                                                                                       |
| --------------- | ------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prompt`        | string | ✗        | Continuation instruction. Same UTF-8 cap as create: at most 65,536 bytes; 65,537 is `400 VALIDATION_ERROR` (`prompt must be at most 65536 bytes`). If omitted, the agent uses a default resume/continue prompt or the CLI’s native resume with no new user text (tool-dependent). |
| `concurrencyId` | string | ✗        | Optional caller assertion; when set, it must exactly match the source session’s inherited concurrency identity. It cannot override that identity.                                                                                                                                 |
| `timeout`       | number | ✗        | Override timeout (seconds). Default: source session’s timeout.                                                                                                                                                                                                                    |
| `priority`      | number | ✗        | Queue priority. Default: source session’s priority.                                                                                                                                                                                                                               |

**Response:** `201 Created`

```json
{
  "id": "sess-r9s8t7",
  "repositoryId": "repo-abc",
  "prompt": "Continue: also fix the edge case in parseDate",
  "ref": "feature/fix-utils",
  "target": { "providerId": "prov-codex" },
  "fallbacks": [{ "commandId": "cmd-echo" }],
  "status": "queued",
  "timeout": 1800,
  "priority": 10,
  "requiredLabels": ["codex"],
  "source": "api",
  "type": "prompt",
  "resumedFromSessionId": "sess-x1y2z3",
  "pinnedHostId": "vps-prod-1",
  "pinExpiresAt": "2026-08-01T14:00:00Z",
  "createdAt": "2026-08-01T13:00:00Z"
}
```

**Scheduling:**

1. New session keeps `resumedFromSessionId` and initially pins the source host plus stored native command/account route and CLI reference. It does not pin a worktree.
2. Scheduler may assign that native route to any eligible worktree for the repository and `ref` on the pinned host when it is idle, online, and not draining.
3. If the native route is unavailable or `pinExpiresAt` passes, clear `cliResumeRef` and every placement/route pin, mark the session as a resume fallback, and assign a fresh run through target/fallback order.
4. `session:assign` includes `resume: true` only for the native route; fresh fallback assignments preserve `resumedFromSessionId` but omit the stale native ref/pins.

**Agent behavior:** see [host-daemon.md — Resume](host-daemon.md#session-resume). On success, status progresses normally. Native resume being unschedulable is not terminal; it becomes a fresh target/fallback assignment.

**Errors:**

| Status | Code               | When                                                                                                       |
| ------ | ------------------ | ---------------------------------------------------------------------------------------------------------- |
| 400    | `VALIDATION_ERROR` | Source never assigned (no agent/worktree); source still `running`/`queued`; prompt over 65,536 UTF-8 bytes |
| 404    | `NOT_FOUND`        | Unknown session id                                                                                         |
| 409    | `CONFLICT`         | Policy reject (e.g. source type `scheduled` without worktree)                                              |

**Clone vs resume:**

|                | Clone                               | Resume                                                                          |
| -------------- | ----------------------------------- | ------------------------------------------------------------------------------- |
| New session id | ✓                                   | ✓                                                                               |
| Placement      | Any matching worktree (round-robin) | Source host for native resume; any eligible worktree there, then fresh routing  |
| Workspace      | Fresh setup script (typical reset)  | Re-check out `ref`; use native CLI resume only while its route remains eligible |
| Prompt         | Copy or override as full new prompt | Continuation / resume-oriented                                                  |

Resume pin and provenance fields are server-managed. The supported product path is
**`POST /sessions/:id/resume`**; `POST /sessions` does not accept placement pins.

#### `POST /sessions/:id/cancel`

Cancel a queued or running session. **Operator (own sessions) or admin.**

**Response:** `200 OK`

```json
{
  "id": "sess-x1y2z3",
  "status": "cancelled"
}
```

#### `GET /sessions/:id/logs`

Get bounded **historical** session logs. For live streaming, use the authenticated read-only browser [WebSocket API](websocket.md#live-session-viewing); it resumes with its `timestampSeq` cursor and never replaces this history query.

**Query parameters:**

| Param    | Type    | Description                                                                          |
| -------- | ------- | ------------------------------------------------------------------------------------ |
| `stream` | string  | Optional enum: `stdout`, `stderr`, or `system`                                       |
| `since`  | string  | Optional ISO 8601 timestamp with an explicit timezone; return logs strictly after it |
| `limit`  | integer | Optional result cap: default `1000`, minimum `1`, safe maximum `10000`               |

Results are always ascending by the durable `timestampSeq` key (timestamp then
agent sequence). Filters apply before `limit`. Invalid query parameters return
`400 VALIDATION_ERROR`; a missing or inaccessible session returns `404 NOT_FOUND`.
Storage failures return `500 INTERNAL_ERROR`. This endpoint is historical only:
it neither opens a WebSocket live tail nor reads S3 archives in the current release.

**Response:** `200 OK`

```json
{
  "items": [
    {
      "timestamp": "2026-08-01T12:00:06Z",
      "stream": "stdout",
      "content": "Analyzing codebase..."
    },
    {
      "timestamp": "2026-08-01T12:00:08Z",
      "stream": "stdout",
      "content": "Found 3 failing tests. Applying fix..."
    }
  ]
}
```

---

### Worktrees

#### `GET /worktrees`

List all worktrees across all connected agents. Optional `?hostId=<id>` filters server-side to a
single host — callers that only need one host's worktrees (a host detail page, a host pane) should
filter here rather than fetching the whole fleet and filtering in JS.

**Response:** `200 OK`

```json
{
  "items": [
    {
      "id": "wt-1",
      "name": "codex-1",
      "hostId": "vps-prod-1",
      "repositoryId": "repo-abc",
      "path": "/home/harness/repos/my-app/.worktrees/wt-1",
      "labels": ["codex", "claude"],
      "status": "idle",
      "currentSessionId": null,
      "lastAssignedAt": "2026-08-01T11:00:00Z"
    }
  ]
}
```

#### `GET /worktrees/:id`

Get worktree details.

---

### Schedules

Schedules run recurring maintenance tasks on the main repository checkout (not worktrees). Useful for dependency updates, linting, formatting, and other automated maintenance. A schedule `ref`, when set, is a **branch name** (not a tag or SHA) and must exist on an eligible host when the job runs.

Scheduled sessions are capability-gated (`scheduled-main-checkout`), always carry
`worktreeId: null`, and use one durable main-checkout lease per `(host, repository)`.
They never contend with or change a worktree assignment.

#### `POST /schedules`

Create a scheduled task. **Operator or admin.**

**Request:**

```json
{
  "repositoryId": "repo-abc",
  "name": "daily-update",
  "target": { "commandId": "cmd-lint-fix" },
  "fallbacks": [{ "providerId": "prov-codex" }],
  "ref": "main",
  "cron": "0 6 * * *",
  "enabled": true
}
```

| Field             | Type     | Required | Description                                                                                                                                        |
| ----------------- | -------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repositoryId`    | string   | ✓        | Target repository                                                                                                                                  |
| `name`            | string   | ✓        | Human-readable name for the schedule                                                                                                               |
| `target`          | object   | ✓        | Primary `{ providerId }` or `{ commandId }` target                                                                                                 |
| `fallbacks`       | object[] | ✗        | Ordered fallback targets; same semantics as sessions                                                                                               |
| `queueTtlSeconds` | number   | ✗        | Absolute queue lifetime for each fire; default 8 days                                                                                              |
| `cron`            | string   | ✓        | Strict five-field UTC cron. Numeric wildcards, lists, ranges, and steps are supported (for example `0,30 6-18/2 * * 1-5`).                         |
| `timeout`         | number   | ✗        | Max duration in seconds. Default: `3600` (1 hour)                                                                                                  |
| `enabled`         | boolean  | ✗        | Default: `true`                                                                                                                                    |
| `ref`             | string   | ✗        | Branch name to check out; must exist on an eligible host. Tags and SHAs are rejected.                                                              |
| `concurrencyId`   | string   | ✗        | Global exact-match identity for each fire, at most 2,048 UTF-8 bytes. Defaults to `schedule-${scheduleId}`; the final derived value is validated.  |
| `prompt`          | string   | ✗        | Prompt passed to the CLI when this schedule fires. Trimmed on write. Missing or blank stays empty — the server does not invent `scheduled:<name>`. |

The server derives `nextRunAt` from `cron` and its UTC clock; clients cannot choose the
cursor. A create or update resets the cursor to the first matching minute strictly after the
server's current time. Invalid cron expressions and supplied timestamps are rejected.

**Response:** `201 Created`

```json
{
  "id": "sched-m1n2o3",
  "repositoryId": "repo-abc",
  "name": "daily-update",
  "target": { "commandId": "cmd-lint-fix" },
  "fallbacks": [{ "providerId": "prov-codex" }],
  "targetDisplayNames": ["lint-fix", "codex"],
  "queueTtlSeconds": 691200,
  "cron": "0 6 * * *",
  "enabled": true,
  "lastRunAt": null,
  "nextRunAt": "2026-08-02T06:00:00Z",
  "createdAt": "2026-08-01T12:00:00Z"
}
```

Each fire creates a fresh session with an absolute `queueExpiresAt` deadline (8 days by
default, or the configured `queueTtlSeconds`). Fallback attempts never extend that deadline.

#### `GET /schedules`

List schedules. Filter by `repositoryId`.

#### `GET /schedules/:id`

Get schedule details including last run status.

#### `PUT /schedules/:id`

Update a schedule. **Operator or admin.** The server recalculates `nextRunAt` from the updated
cron and current UTC time. If changing `ref`, it must be a branch name; tags and SHAs are rejected.

#### `DELETE /schedules/:id`

Delete a schedule. **Admin only.**

#### `POST /schedules/:id/trigger`

Manually trigger a schedule immediately. Creates a session with `type: 'scheduled'` and `source: 'schedule'`. **Operator or admin.**

**Response:** `201 Created` with `created: true`, or `200 OK` with `created: false` and the existing session when the manual trigger is a duplicate.

```json
{
  "sessionId": "sess-t1r2g3",
  "scheduleId": "sched-m1n2o3",
  "status": "queued",
  "created": true,
  "concurrencyId": "schedule-sched-m1n2o3"
}
```

Automatic cron fires use `schedule-${scheduleId}` unless the schedule supplies an explicit concurrency identity. If a prior fire is still active, cron skips creating a duplicate, advances `nextRunAt`, and leaves `lastRunAt` unchanged. This makes overlap safe while preserving the timestamp of the last session that actually ran.

---

### Hosts

#### `GET /api/v1/hosts`

List configured hosts, including connection health and local daemon restart observability.

Each host also reports `daemonVersion`, `gitVersion`, `gitReady`, and a bounded
`gitReadinessReason`. `online` is connection liveness, not schedulability: legacy daemons or hosts
whose Git preflight fails remain visible as online but have `gitReady: false` and receive no work.

**Response:** `200 OK`

```json
{
  "items": [
    {
      "hostId": "vps-prod-1",
      "online": true,
      "connectedAt": "2026-08-01T08:00:00Z",
      "lastHeartbeatAt": "2026-08-01T08:00:30Z",
      "daemonStartedAt": "2026-08-01T07:00:00Z",
      "daemonVersion": "0.0.0",
      "gitVersion": "2.44.0",
      "gitReady": true,
      "gitReadinessReason": null,
      "restartCount": 1,
      "lastRestartDetectedAt": "2026-08-01T07:00:02Z",
      "worktreeIds": ["docs"],
      "repositoryIds": ["auto-harness"]
    }
  ]
}
```

The first modern daemon registration establishes a baseline and returns `restartCount: 0`. Socket
reconnects reuse the daemon instance id and do not increment the count. A later process identity
increments the durable count and stamps detection time using the control-plane clock. Legacy
daemons remain compatible and report an unknown start time. These fields do not trigger a host
restart or an external notification.

---

### Providers, Provider Accounts, and Commands

Three global catalogs are available to session/schedule target chains instead of a free-form command string (D4). A **Command** is a name + fixed `argv` + `appendPrompt`, optionally owned by a **Provider** (`providerId: null` = standalone providerless pure CLI, runs ungated on any worktree). A **Provider** (e.g. `claude`, `codex`) has a `defaultCommandId`. A **Provider Account** is a specific account of a Provider, attached to one or more hosts. Provider targets draw from the provider's healthy attached account pool; provider-owned explicit Commands use that command exactly while still drawing from its provider pool. The control plane resolves the route at assignment time, not create time (see [websocket.md](websocket.md) `session:assign`).

Deleting a Command returns `409 Conflict` while it is a Provider default or is selected by any host-, repository-, or worktree-level Provider Account command override. Conflict responses include each blocking Provider Account ID and exact override scope; clear or replace every reference before retrying deletion.

Catalog CRUD below is **admin** (and control-plane-only — there's no host-pane
equivalent). Operators create sessions; they do not add hosts, repositories, or
providers. See [auth.md](auth.md#roles).

#### `POST /providers`

Create a provider. **Does not** create its default command — the control-plane UI's "Add provider" dialog does both in one step (create provider → create its command → `PATCH` `defaultCommandId`) to avoid shipping a provider with no default; scripting this yourself needs the same three calls.

**Request:** `{ "name": "claude" }` (slug: lowercase letters, numbers, dashes)

**Response:** `201 Created` — `{ "id", "name", "defaultCommandId": null, "createdAt", "updatedAt" }`

#### `GET /providers`, `GET /providers/:id`, `PATCH /providers/:id`, `DELETE /providers/:id`

Standard CRUD. `PATCH` body: `{ "name"?, "defaultCommandId"?, "usageRates"? }` (`defaultCommandId: null` and `usageRates: null` clear those fields). `usageRates` is optional operator-configured integer micros plus an ISO currency; Auto Harness never fetches vendor prices. The Provider Settings tab is the structured editor.
`DELETE` fails `409` while an account, command, schedule, or queued/running session references the
provider. The response identifies every live dependency; deletion never cascades.

#### `POST /provider-accounts`

**Request:** `{ "providerId": "prov-1", "label": "jonathanrichardong@gmail.com", "maxConcurrentSessions"?: 1 }`

**Response:** `201 Created` — `{ "id", "providerId", "label", "maxConcurrentSessions", "createdAt", "updatedAt" }`. `providerId` must reference an existing provider (`400` otherwise). `maxConcurrentSessions` defaults to `1` (integer 1–64).

#### `GET /provider-accounts`, `GET /provider-accounts/:id`, `PATCH /provider-accounts/:id`, `DELETE /provider-accounts/:id`

Standard CRUD. `GET /provider-accounts` returns `{ "items": [ ...accounts ] }`, not a bare array. Create/update accepts `usageLimitCooldownSeconds` (default `18000`, 5 hours) and `maxConcurrentSessions` (default `1`). Responses include `usageLimitedUntil`, `lastUsageLimitedAt`, `lastAssignedAt`, and `maxConcurrentSessions`. The scheduler enforces the cap with attempt-owned durable leases (same conditional-put pattern as `concurrencyId` locks). Assignment fails closed when a host has not advertised a ready execution profile for that exact account. `DELETE` fails `409` while host inventory or a queued/running session references the account; deletion never cascades. `DELETE /provider-accounts/:id/usage-limit` clears an active cooldown and triggers scheduling.

#### `POST /commands`

**Request:** `{ "name": "claude-print", "argv": ["claude", "-p", "--output-format", "json"], "appendPrompt": true, "providerId": "prov-1" }` (`providerId: null` for standalone)

**Response:** `201 Created` — `{ "id", "name", "argv", "appendPrompt", "providerId", "createdAt", "updatedAt" }`. `argv` must be a non-empty array of non-empty strings — never a shell string.

For compatibility with provider commands stored before structured usage reporting,
dispatch upgrades only recognized native forms that have no explicit output setting:
`claude -p` / `--print`, `gemini -p` / `--prompt`, and `grok -p` / `--single` receive
`--output-format json`; `codex exec` receives `--json`. This happens in the resolved
execution argv so quota routing continues to receive vendor envelopes. Commands with an explicit
format or an unrecognized executable remain operator-authored and unchanged.

`appendPromptSeparator` controls whether a `--` element is inserted before the appended
prompt: `[...command.argv, "--", prompt]` vs `[...command.argv, prompt]`
(`services/api/src/control-plane-session-target.ts`). If not given explicitly, it
**defaults to `true` whenever the command has a non-null `providerId`** and `appendPrompt`
is not `false` (`services/api/src/control-plane-commands.ts`) — a providerless command
defaults to `false`. So `{"argv":["claude","-p","--output-format","json"],"appendPrompt":true,"providerId":"prov-1"}`
actually spawns `claude -p --output-format json -- "<prompt>"`, not `claude -p "<prompt>"` — confirmed against a
real session's `resolvedArgv`. This is harmless for CLIs that treat `--` as
"end of options" (`claude`, `codex`), but will break any provider-owned command whose
binary does not accept `--`, or a naive `printf "%s"`-style invocation where a prompt
starting with `-` would otherwise be misread as a flag.

#### `GET /commands`, `GET /commands/:id`, `PUT /commands/:id`, `DELETE /commands/:id`

Standard CRUD. `providerId` is a **soft** foreign key — the UI filters/suggests by it, but a mismatched value is never hard-blocked. `DELETE` fails `409` while the command is a provider default, inventory override, schedule target, or queued/running session target. The response identifies live dependencies; deletion never cascades.

#### `GET /session-targets`

Unified picker source for session/schedule creation: all Providers and Commands, including provider-owned Commands and providerless (`providerId: null`) Commands. Provider Accounts are capacity records, not direct session targets; the UI shows their health/cooldown on provider and host pages.

**Response:** `200 OK`

```json
{
  "items": [
    {
      "kind": "provider",
      "id": "prov-1",
      "label": "claude"
    },
    { "kind": "command", "id": "cmd-1", "label": "echo hello world", "providerId": null }
  ]
}
```

#### Host inventory: setup and Provider Accounts

`GET /api/v1/hosts/:hostId/inventory` still returns the full host document, including setup
scripts, terminal hook paths, and `allowedRoots`. Ordinary inventory writes do not.

`PUT /api/v1/hosts/:hostId/inventory` (see [cli.md](cli.md), `fleet:inventory`) attaches
repositories and worktrees, labels, required environment, and provider-account attachments.
Omitted exec-config fields are **always** preserved from the stored document, including for
admin / unauthenticated local callers. A body that would change `setupScript`,
`terminalHookScript`, or `allowedRoots` returns `403 FORBIDDEN` unless the caller also has
`fleet:exec-config`. Callers with that capability may include those fields in a full-document
PUT (the raw JSON editor) to change them; omitted keys still stay stored. Those writes also
append `host-exec-config:update`. Removing a repository or worktree that contains one of those
fields is also an exec-config edit. Every inventory replacement is fenced by the version the
server just read (including versionless requests), so a concurrent write returns `409 CONFLICT`
rather than restoring stale executable configuration; deletes use the same fence. The successful
exec-config audit is persisted before a full-document inventory replacement can commit.

`PUT /api/v1/hosts/:hostId/exec-config` (`fleet:exec-config`, admin only) is the structured write
path for host-, repository-, and worktree-scoped setup scripts, repository `terminalHookScript`
paths, and host-local `allowedRoots`. Omitted keys are left unchanged. Empty strings / empty
`allowedRoots` clear the stored value. A host with no inventory yet is created empty, then the
patch is applied. Unknown repository or worktree ids return `400 VALIDATION_ERROR`. Non-empty
new or changed `terminalHookScript` values must be absolute paths on both this route and
`PUT /inventory`. A relative hook persisted by an earlier release may be carried through an
otherwise unrelated write only when it is exactly unchanged; replacing or clearing it migrates
the document to the current rule.
The success audit is recorded **before** the durable write; if that audit cannot be persisted the
document is left unchanged (HTTP 500). If the following write fails, a failed
`host-exec-config:update` is also recorded. Successful writes include the changed field paths
(not script bodies).

`allowedRoots` is a list of absolute host directories. When set, the daemon `realpath`s inventory
filesystem paths and terminal hook paths (resolving symlinks and not-yet-created suffixes against
the longest existing prefix) and refuses anything outside those roots. Empty/absent roots apply
no extra restriction. See [host-daemon.md](host-daemon.md#setup-scripts) for setup-script
precedence, environment forwarding, resume behavior, and security boundaries.

The same inventory document carries
`providerAccounts: [{ providerAccountId, commandId? }]` — the host-level attachment list, with an
optional host-level command override per account. Each `providerAccountId` must already exist in
the catalog; unknown ids return `400 VALIDATION_ERROR` (`unknown providerAccountId: …`). An empty
`providerAccounts` list remains valid. Per-repository and per-worktree overrides
(`enabled?`, `commandId?`) live on the corresponding entries inside that same document's
`repositories[].providerAccountOverrides` / `repositories[].worktrees[].providerAccountOverrides`.

---
