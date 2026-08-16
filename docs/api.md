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

`concurrencyId` is an exact, caller-chosen idempotency/concurrency identity shared by manual and scheduled creates. While its lock is held, a repeated create returns `200 OK` with the existing session and `created: false`; a new identity returns `201 Created` with `created: true`. A terminal session releases its lock, so a later request may retry with the same id. The lock is durable and atomic across API workers.

**CI / repo harness:** create sessions with `POST /sessions` (or `/resume`) and **return immediately** — fire and forget. Do not hold the caller open for session completion; humans watch [Slack](integrations.md) and GitHub. Patterns: [harness.md](harness.md).

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

`401` if missing/invalid; `403` if role insufficient.

### `POST /auth/viewer-ticket`

Issue a short-lived, single-purpose browser WebSocket credential from the authenticated session cookie. The browser presents it only as the `ticket` query parameter on `/ws/viewer`; service-account credentials are never accepted by that read-only socket.

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

| Status | Code               | Description                             |
| ------ | ------------------ | --------------------------------------- |
| 400    | `VALIDATION_ERROR` | Invalid or missing request body fields  |
| 401    | `UNAUTHORIZED`     | Missing or invalid token                |
| 403    | `FORBIDDEN`        | Insufficient role permissions           |
| 404    | `NOT_FOUND`        | Resource not found                      |
| 409    | `CONFLICT`         | Resource conflict (e.g. duplicate name) |
| 429    | `RATE_LIMITED`     | Too many requests; see `Retry-After`    |
| 500    | `INTERNAL_ERROR`   | Unexpected server error                 |

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
| `role`                | string   | ✓        | `read-only`, `operator`, or `admin`                                                                                      |
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
only `botTokenConfigured` and `signingSecretConfigured` flags. `DELETE` returns
`204`.

KMS encrypts the secret fields with `KMS_KEY_ID` and the stable
`auto-harness/slack-integration` / `slack` encryption context before the
configuration reaches DynamoDB. Missing KMS configuration or an encryption
failure fails the write closed. Configuration writes use a durable version so a
stale worker receives `409 CONFLICT`, rather than overwriting another worker.
All create, update, delete, validation, and storage outcomes are audit events;
the request body and secret values are never passed to audit metadata.

This configuration endpoint does not implement Slack OAuth, incoming events,
outbound HTTP, or production session-thread delivery. A local lifecycle worker
can run only when a transport is explicitly injected; the API supplies none.

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
  "setupScript": "pnpm install"
}
```

**Response:** `201 Created`

```json
{
  "id": "repo-abc",
  "name": "my-app",
  "url": "git@github.com:org/my-app.git",
  "defaultBranch": "main",
  "setupScript": "pnpm install",
  "createdAt": "2026-08-01T00:00:00Z"
}
```

#### `GET /repositories`

List all repositories.

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
  ]
}
```

The three count fields are durable, index-backed totals for each repository visible to the
authenticated principal. Host-bound credentials receive session and worktree totals for their host.
Session totals can briefly lag a just-committed write while DynamoDB propagates its repository index.

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

Create a new session. This is the main endpoint for triggering AI work. **Operator or admin.**

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
  "concurrencyId": "filaments-pr-shepherd-123",
  "metadata": { "pullRequest": 123 },
  "source": "ui"
}
```

| Field             | Type     | Required | Description                                                                                                                                                            |
| ----------------- | -------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repositoryId`    | string   | ✓        | Target repository                                                                                                                                                      |
| `prompt`          | string   | ✓        | The prompt/instruction for the AI agent                                                                                                                                |
| `ref`             | string   | ✗        | Branch, tag, or commit SHA to check out. The repository default branch is used when omitted.                                                                           |
| `target`          | object   | ✓        | Primary `{ providerId }` or `{ commandId }` target. Provider targets use the provider's eligible account pool; providerless Commands (`providerId: null`) run ungated. |
| `fallbacks`       | object[] | ✗        | Ordered additional targets. The scheduler advances only when the preceding target has no eligible route.                                                               |
| `queueTtlSeconds` | number   | ✗        | Absolute queue lifetime, default `691200` (8 days). Expiry reports `queue_expired`; fallback attempts do not reset it.                                                 |
| `timeout`         | number   | ✓        | Max session duration in seconds. The agent kills the process after this time.                                                                                          |
| `priority`        | number   | ✗        | Higher = more urgent. Default: `0`                                                                                                                                     |
| `requiredLabels`  | string[] | ✗        | Worktree labels required. Default: `[]` (any worktree)                                                                                                                 |
| `source`          | string   | ✗        | Origin of the session: `api`, `ui`, `webhook`, `schedule`. Default: `api`                                                                                              |
| `type`            | string   | ✗        | Session type: `prompt` (runs in worktree) or `scheduled` (runs on main checkout). Default: `prompt`                                                                    |
| `concurrencyId`   | string   | ✗        | Global exact-match identity. An active duplicate returns the existing session (`200`, `created: false`); terminal sessions release the identity for retry.             |
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
  "targetLabel": "codex-fix",
  "status": "queued",
  "timeout": 1800,
  "priority": 10,
  "requiredLabels": ["codex"],
  "concurrencyId": "filaments-pr-shepherd-123",
  "url": "http://127.0.0.1:7421/sessions/sess-x1y2z3",
  "created": true,
  "source": "ui",
  "type": "prompt",
  "createdAt": "2026-08-01T12:00:00Z"
}
```

`targetLabel` is a human-readable label for the resolved target (the Command's name, or `"<provider> — <account label>"`), useful for display without a second lookup. Once assigned, the session record also gains `resolvedArgv: string[]` — the exact argv the agent spawned.

The session enters the `queued` state. The scheduler assigns it to an idle worktree that matches the repository and required labels on an online agent. If multiple worktrees match, assignment is **round-robin** (least recently assigned first). If none are available, it remains queued.

If the session exceeds `timeout` seconds while running, the agent kills the process and the status becomes `timed_out`.

If the agent detects an **AI vendor usage/rate limit** in CLI output, it reports `errorCode: "usage_limit"`. The control plane pauses the assigned Provider Account globally for its configured cooldown (default 5 hours), releases the worktree, and immediately tries the next eligible account or fallback. Providerless commands do not pause an account. See [host-daemon.md — Usage limits](host-daemon.md#usage-limits-ai-vendor--cli-quotas).

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
| `concurrencyId` | string | Exact concurrency identity (may span schedules and manual sessions)                                        |
| `scheduleId`    | string | Exact schedule provenance; used for one schedule's run history                                             |

Results are scoped to the authenticated principal's allowed repositories and host binding
before the `limit` is applied. `nextCursor` is an opaque, signed cursor bound to all filters,
sort order, and principal scope; changing or tampering with those values returns `400`. Invalid
limits, statuses, sources, empty filter values, and duplicate filter parameters return a structured `400`.

For multi-worker deployments, set `HARNESS_CURSOR_SECRET` to the same stable secret on every API
worker (or use the existing shared `HARNESS_SESSION_SECRET` as its fallback). If neither variable
is set, a random process-local secret is used; cursors from that fallback are valid only in the
same local-memory process and must not be used for a distributed deployment.

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
  "resolvedRoute": null,
  "createdAt": "2026-08-01T12:00:00Z",
  "startedAt": "2026-08-01T12:00:05Z",
  "completedAt": null
}
```

| Field                           | When set                                                                                           |
| ------------------------------- | -------------------------------------------------------------------------------------------------- |
| `hostId` / `worktreeId`         | Set when assigned; the recorded Host and Worktree are included in route diagnostics                |
| `errorCode`                     | Optional machine-readable failure reason, e.g. `usage_limit` or `queue_expired`                    |
| `errorMessage`                  | Optional short human excerpt from the match / logs                                                 |
| `resumedFromSessionId`          | Set on sessions created via resume — parent session id                                             |
| `pinnedHostId` / `pinExpiresAt` | Temporary host-only native-resume preference and deadline; cleared before fresh fallback routing   |
| `cliResumeRef`                  | Optional opaque id from the AI CLI for native resume; discarded when falling back to a fresh route |
| `queueExpiresAt`                | Fixed absolute queue deadline; fallback attempts never extend it                                   |
| `resolvedRoute`                 | Last route diagnostics: target index, Provider Account, Command, Host, and Worktree (no secrets)   |

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
  "timeout": 1800,
  "priority": 10
}
```

| Field      | Type   | Required | Description                                                                                                                                          |
| ---------- | ------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prompt`   | string | ✗        | Continuation instruction. If omitted, agent uses a default resume/continue prompt or the CLI’s native resume with no new user text (tool-dependent). |
| `timeout`  | number | ✗        | Override timeout (seconds). Default: source session’s timeout.                                                                                       |
| `priority` | number | ✗        | Queue priority. Default: source session’s priority.                                                                                                  |

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

| Status | Code               | When                                                                       |
| ------ | ------------------ | -------------------------------------------------------------------------- |
| 400    | `VALIDATION_ERROR` | Source never assigned (no agent/worktree); source still `running`/`queued` |
| 404    | `NOT_FOUND`        | Unknown session id                                                         |
| 409    | `CONFLICT`         | Policy reject (e.g. source type `scheduled` without worktree)              |

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

List all worktrees across all connected agents.

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

| Field             | Type     | Required | Description                                                                                                                           |
| ----------------- | -------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `repositoryId`    | string   | ✓        | Target repository                                                                                                                     |
| `name`            | string   | ✓        | Human-readable name for the schedule                                                                                                  |
| `target`          | object   | ✓        | Primary `{ providerId }` or `{ commandId }` target                                                                                    |
| `fallbacks`       | object[] | ✗        | Ordered fallback targets; same semantics as sessions                                                                                  |
| `queueTtlSeconds` | number   | ✗        | Absolute queue lifetime for each fire; default 8 days                                                                                 |
| `cron`            | string   | ✓        | Strict five-field UTC cron. Numeric wildcards, lists, ranges, and steps are supported (for example `0,30 6-18/2 * * 1-5`).            |
| `timeout`         | number   | ✗        | Max duration in seconds. Default: `3600` (1 hour)                                                                                     |
| `enabled`         | boolean  | ✗        | Default: `true`                                                                                                                       |
| `ref`             | string   | ✗        | Branch name to check out; must exist on an eligible host. Tags and SHAs are rejected.                                                 |
| `concurrencyId`   | string   | ✗        | Global exact-match identity for each fire. Defaults to `schedule-${scheduleId}` for automatic fires; an explicit value is used as-is. |

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
  "targetLabels": ["lint-fix", "codex"],
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

All CRUD below is **operator or admin**, and control-plane-only — there's no host-pane equivalent.

#### `POST /providers`

Create a provider. **Does not** create its default command — the control-plane UI's "Add provider" dialog does both in one step (create provider → create its command → `PATCH` `defaultCommandId`) to avoid shipping a provider with no default; scripting this yourself needs the same three calls.

**Request:** `{ "name": "claude" }` (slug: lowercase letters, numbers, dashes)

**Response:** `201 Created` — `{ "id", "name", "defaultCommandId": null, "createdAt", "updatedAt" }`

#### `GET /providers`, `GET /providers/:id`, `PATCH /providers/:id`, `DELETE /providers/:id`

Standard CRUD. `PATCH` body: `{ "name"?, "defaultCommandId"? }` (`defaultCommandId: null` clears it).
`DELETE` fails `409` while an account, command, schedule, or queued/running session references the
provider. The response identifies every live dependency; deletion never cascades.

#### `POST /provider-accounts`

**Request:** `{ "providerId": "prov-1", "label": "jonathanrichardong@gmail.com" }`

**Response:** `201 Created` — `{ "id", "providerId", "label", "createdAt", "updatedAt" }`. `providerId` must reference an existing provider (`400` otherwise).

#### `GET /provider-accounts`, `GET /provider-accounts/:id`, `PATCH /provider-accounts/:id`, `DELETE /provider-accounts/:id`

Standard CRUD. Create/update accepts `usageLimitCooldownSeconds` (default `18000`, 5 hours), and responses include `usageLimitedUntil`, `lastUsageLimitedAt`, and `lastAssignedAt`. `DELETE` fails `409` while host inventory or a queued/running session references the account; deletion never cascades. `DELETE /provider-accounts/:id/usage-limit` clears an active cooldown and triggers scheduling.

#### `POST /commands`

**Request:** `{ "name": "claude-print", "argv": ["claude", "-p"], "appendPrompt": true, "providerId": "prov-1" }` (`providerId: null` for standalone)

**Response:** `201 Created` — `{ "id", "name", "argv", "appendPrompt", "providerId", "createdAt", "updatedAt" }`. `argv` must be a non-empty array of non-empty strings — never a shell string.

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

#### Host inventory: attaching a Provider Account

`PUT /api/v1/hosts/:hostId/inventory` (see [cli.md](cli.md)) carries
`providerAccounts: [{ providerAccountId, commandId? }]` — the host-level attachment list, with an
optional host-level command override per account. Per-repository and per-worktree overrides
(`enabled?`, `commandId?`) live on the corresponding entries inside that same document's
`repositories[].providerAccountOverrides` / `repositories[].worktrees[].providerAccountOverrides`.

---
