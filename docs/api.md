# REST API

HTTP API for sessions, repositories, auth, schedules, and agents. Served at `/api/v1` via API Gateway + Lambda.

Live streaming and agent control use the [WebSocket protocol](websocket.md). Credentials: [auth.md](auth.md). Deploy: [setup.md](setup.md). Local stack: [local-development.md](local-development.md).

**Phase 2+ fields on `POST /sessions`:** `ref`, exactly one of `providerAccountId`/`commandId` (not free-form `command`), `concurrencyKey`, `onConflict`, `metadata`; response includes UI `url` and `targetLabel`. Resume pins **agent only** (D5). List search is client-side only (no DynamoDB full-text).

**CI / repo harness:** create sessions with `POST /sessions` (or `/resume`) and **return immediately** — fire and forget. Do not hold the caller open for session completion; humans watch [Slack](integrations.md) and GitHub. Patterns: [harness.md](harness.md).

## Authentication

| Method         | Format                               | Used by                        |
| -------------- | ------------------------------------ | ------------------------------ |
| Session cookie | `Cookie: auto_harness_session=<jwt>` | Web UI                         |
| Bearer token   | `Authorization: Bearer hns_…`        | Service accounts (CI, scripts) |
| Basic auth     | `Authorization: Basic …`             | Admin / user direct API calls  |

`401` if missing/invalid; `403` if role insufficient.

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
| 429    | `RATE_LIMITED`     | Too many requests                       |
| 500    | `INTERNAL_ERROR`   | Unexpected server error                 |

Rate limit headers on all responses:

- `X-RateLimit-Limit`
- `X-RateLimit-Remaining`
- `X-RateLimit-Reset`

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

**Response:** `200 OK` + `Set-Cookie: auto_harness_session=; Max-Age=0`

#### `GET /auth/me`

Get the current authenticated user's info.

**Response:** `200 OK`

```json
{
  "username": "jong",
  "role": "operator",
  "type": "user"
}
```

The `type` field is `admin` (env var), `user` (DynamoDB), or `service-account`.

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
  "id": "sa-a1b2c3d4",
  "name": "ci-frontend",
  "role": "operator",
  "allowedRepositories": ["repo-abc"],
  "apiKey": "hns_k8f2m9x...",
  "createdAt": "2026-08-01T00:00:00Z"
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
      "id": "sa-a1b2c3d4",
      "name": "ci-frontend",
      "role": "operator",
      "allowedRepositories": ["repo-abc"],
      "createdAt": "2026-08-01T00:00:00Z"
    }
  ]
}
```

#### `DELETE /auth/service-accounts/:id`

Delete a service account and revoke its API key. **Admin only.**

**Response:** `204 No Content`

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
      "createdAt": "2026-08-01T00:00:00Z"
    }
  ]
}
```

#### `GET /repositories/:id`

Get repository details.

#### `PUT /repositories/:id`

Update a repository. **Admin only.**

#### `DELETE /repositories/:id`

Delete a repository. **Admin only.** Fails if there are active sessions for this repository.

---

### Sessions

#### `POST /sessions`

Create a new session. This is the main endpoint for triggering AI work. **Operator or admin.**

**Request:**

```json
{
  "repositoryId": "repo-abc",
  "prompt": "Fix the failing test in src/utils.test.ts",
  "commandId": "cmd-codex-fix",
  "timeout": 1800,
  "priority": 10,
  "requiredLabels": ["codex"],
  "source": "ui"
}
```

| Field                           | Type     | Required    | Description                                                                                                                                                                                                                                |
| ------------------------------- | -------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `repositoryId`                  | string   | ✓           | Target repository                                                                                                                                                                                                                          |
| `prompt`                        | string   | ✓           | The prompt/instruction for the AI agent                                                                                                                                                                                                    |
| `providerAccountId`/`commandId` | string   | exactly one | Session target — a Provider Account (cascade-resolved to a Command at assign time) or a standalone Command. Never a free-form command string. See [Providers, Provider Accounts, and Commands](#providers-provider-accounts-and-commands). |
| `timeout`                       | number   | ✓           | Max session duration in seconds. The agent kills the process after this time.                                                                                                                                                              |
| `priority`                      | number   | ✗           | Higher = more urgent. Default: `0`                                                                                                                                                                                                         |
| `requiredLabels`                | string[] | ✗           | Worktree labels required. Default: `[]` (any worktree)                                                                                                                                                                                     |
| `source`                        | string   | ✗           | Origin of the session: `api`, `ui`, `webhook`, `schedule`. Default: `api`                                                                                                                                                                  |
| `type`                          | string   | ✗           | Session type: `prompt` (runs in worktree) or `scheduled` (runs on main checkout). Default: `prompt`                                                                                                                                        |

An unknown `providerAccountId`/`commandId`, or a body with both/neither, is rejected `400` at create time.

> **Note:** The Web UI uses this same endpoint to create sessions directly from the browser. The UI provides a form with repo selection, prompt text area, a target picker (`GET /session-targets` — Provider Accounts and standalone Commands), timeout, priority slider, and label selection.

**Response:** `201 Created`

```json
{
  "id": "sess-x1y2z3",
  "repositoryId": "repo-abc",
  "prompt": "Fix the failing test in src/utils.test.ts",
  "commandId": "cmd-codex-fix",
  "targetLabel": "codex-fix",
  "status": "queued",
  "timeout": 1800,
  "priority": 10,
  "requiredLabels": ["codex"],
  "source": "ui",
  "type": "prompt",
  "createdAt": "2026-08-01T12:00:00Z"
}
```

`targetLabel` is a human-readable label for the resolved target (the Command's name, or `"<provider> — <account label>"`), useful for display without a second lookup. Once assigned, the session record also gains `resolvedArgv: string[]` — the exact argv the agent spawned.

The session enters the `queued` state. The scheduler assigns it to an idle worktree that matches the repository and required labels on an online agent. If multiple worktrees match, assignment is **round-robin** (least recently assigned first). If none are available, it remains queued.

If the session exceeds `timeout` seconds while running, the agent kills the process and the status becomes `timed_out`.

If the agent detects an **AI vendor usage/rate limit** in CLI output, the session ends as `failed` with `errorCode: "usage_limit"` (no automatic retry). See [host-daemon.md — Usage limits](host-daemon.md#usage-limits-ai-vendor--cli-quotas).

#### `GET /sessions`

List sessions with optional filters.

**Query parameters:**

| Param          | Type   | Description                                                                            |
| -------------- | ------ | -------------------------------------------------------------------------------------- |
| `status`       | string | Filter by status: `queued`, `running`, `completed`, `failed`, `cancelled`, `timed_out` |
| `repositoryId` | string | Filter by repository                                                                   |
| `search`       | string | Full-text search across session prompts                                                |
| `sort`         | string | Sort order: `latest` (default), `oldest`, `priority_desc`, `priority_asc`              |
| `limit`        | number | Max results (default: 50, max: 100)                                                    |
| `cursor`       | string | Pagination cursor from previous response                                               |

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
  "command": "codex -p",
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
  "cliResumeRef": null,
  "createdAt": "2026-08-01T12:00:00Z",
  "startedAt": "2026-08-01T12:00:05Z",
  "completedAt": null
}
```

| Field                   | When set                                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `hostId` / `worktreeId` | Set when assigned (used later for [resume](#post-sessionsidresume))                                                |
| `errorCode`             | Optional machine-readable failure reason, e.g. `usage_limit` when the agent parsed a vendor quota/rate-limit error |
| `errorMessage`          | Optional short human excerpt from the match / logs                                                                 |
| `resumedFromSessionId`  | Set on sessions created via resume — parent session id                                                             |
| `pinnedHostId`          | Resume affinity: when set, scheduler assigns only this host; any eligible idle worktree on that host may be used   |
| `cliResumeRef`          | Optional opaque id from the AI CLI (if captured) for native resume                                                 |

#### `POST /sessions/:id/clone`

Clone a session — creates a **new** session with the same prompt, command, timeout, priority, and labels. Assignment uses normal **label match + round-robin** (any eligible worktree). **Operator or admin.**

Optional request body to override fields:

```json
{
  "prompt": "Updated prompt text",
  "priority": 20
}
```

**Response:** `201 Created` (same schema as `POST /sessions` response)

#### `POST /sessions/:id/resume`

Resume work from a prior session. Pass the **session id** in the path; the control plane pins the new run to the **same host** as the source session. The scheduler may use any eligible idle worktree on that host, re-checks out the source `ref` when present (otherwise the repository default branch), skips setup, and then invokes native resume when configured.

**Operator or admin.** The source must be terminal (`completed`, `failed`, `cancelled`, or `timed_out`) and must retain the host recorded by its prior assignment. Terminal cleanup releases and clears its worktree claim; the continuation may use any eligible idle worktree on that same host.

**Request (optional body):**

```json
{
  "prompt": "Continue: also fix the edge case in parseDate",
  "timeout": 1800,
  "priority": 10
}
```

| Field      | Type   | Required | Description                                                                                     |
| ---------- | ------ | -------- | ----------------------------------------------------------------------------------------------- |
| `prompt`   | string | ✗        | Continuation instruction. If omitted, defaults exactly to `Continue from the previous session.` |
| `timeout`  | number | ✗        | Override timeout (seconds). Default: source session’s timeout.                                  |
| `priority` | number | ✗        | Queue priority. Default: source session’s priority.                                             |

**Response:** `201 Created`

```json
{
  "id": "sess-r9s8t7",
  "repositoryId": "repo-abc",
  "prompt": "Continue: also fix the edge case in parseDate",
  "command": "codex -p",
  "status": "queued",
  "timeout": 1800,
  "priority": 10,
  "requiredLabels": ["codex"],
  "source": "api",
  "type": "prompt",
  "resumedFromSessionId": "sess-x1y2z3",
  "pinnedHostId": "vps-prod-1",
  "createdAt": "2026-08-01T13:00:00Z"
}
```

**Scheduling (host-pinned):**

1. New session is `queued` with `pinnedHostId` copied from the source; it is not pinned to a worktree.
2. Scheduler assigns any eligible idle worktree on that online, non-draining host.
3. If the host is offline, draining, or has no eligible worktree, the session stays queued until `pinExpiresAt`; expiry fails with `resume_failed`.
4. `session:assign` includes `resume: true`, `resumedFromSessionId`, optional source `ref`, and any stored `cliResumeRef`.

**Agent behavior:** see [host-daemon.md — Resume](host-daemon.md#session-resume). On success, status progresses normally; if resume is impossible, session `failed` with `errorCode: "resume_failed"` (or similar).

**Errors:**

| Status | Code               | When                                                                                   |
| ------ | ------------------ | -------------------------------------------------------------------------------------- |
| 400    | `VALIDATION_ERROR` | Source never assigned (no agent/worktree); source still `running`/`queued`             |
| 404    | `NOT_FOUND`        | Unknown session id                                                                     |
| 409    | `RESUME_ERROR`     | Policy reject: source type is `scheduled` (scheduled work has no worktree resume path) |

**Clone vs resume:**

|                | Clone                               | Resume                                                                                                          |
| -------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| New session id | ✓                                   | ✓                                                                                                               |
| Placement      | Any matching worktree (round-robin) | Any eligible worktree on the pinned host                                                                        |
| Workspace      | Fresh setup script (typical reset)  | Re-checkout `ref` when present (otherwise default branch); skip setup; native resume or frozen command fallback |
| Prompt         | Copy or override as full new prompt | Continuation / resume-oriented                                                                                  |

The supported product path is **`POST /sessions/:id/resume`**; callers do not need to supply pin fields.

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

Get **historical** session logs. For live streaming, use the [WebSocket API](websocket.md#live-session-viewing).

**Query parameters:**

| Param    | Type   | Description                                      |
| -------- | ------ | ------------------------------------------------ |
| `stream` | string | Filter by stream: `stdout`, `stderr`, `system`   |
| `since`  | string | ISO 8601 timestamp — return logs after this time |
| `limit`  | number | Max log entries (default: 1000)                  |

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

Schedules run recurring maintenance tasks on the main repository checkout (not worktrees). Useful for dependency updates, linting, formatting, and other automated maintenance.

#### `POST /schedules`

Create a scheduled task. **Operator or admin.**

**Request:**

```json
{
  "repositoryId": "repo-abc",
  "name": "daily-update",
  "commandId": "cmd-lint-fix",
  "cron": "0 6 * * *",
  "enabled": true
}
```

| Field                           | Type    | Required    | Description                                                    |
| ------------------------------- | ------- | ----------- | -------------------------------------------------------------- |
| `repositoryId`                  | string  | ✓           | Target repository                                              |
| `name`                          | string  | ✓           | Human-readable name for the schedule                           |
| `providerAccountId`/`commandId` | string  | exactly one | Same target model as sessions — never a free-form shell string |
| `cron`                          | string  | ✓           | Cron expression (5-field)                                      |
| `timeout`                       | number  | ✗           | Max duration in seconds. Default: `3600` (1 hour)              |
| `enabled`                       | boolean | ✗           | Default: `true`                                                |

**Response:** `201 Created`

```json
{
  "id": "sched-m1n2o3",
  "repositoryId": "repo-abc",
  "name": "daily-update",
  "commandId": "cmd-lint-fix",
  "targetLabel": "lint-fix",
  "cron": "0 6 * * *",
  "enabled": true,
  "lastRunAt": null,
  "nextRunAt": "2026-08-02T06:00:00Z",
  "createdAt": "2026-08-01T12:00:00Z"
}
```

#### `GET /schedules`

List schedules. Filter by `repositoryId`.

#### `GET /schedules/:id`

Get schedule details including last run status.

#### `PUT /schedules/:id`

Update a schedule. **Operator or admin.**

#### `DELETE /schedules/:id`

Delete a schedule. **Admin only.**

#### `POST /schedules/:id/trigger`

Manually trigger a schedule immediately. Creates a session with `type: 'scheduled'` and `source: 'schedule'`. **Operator or admin.**

**Response:** `201 Created`

```json
{
  "sessionId": "sess-t1r2g3",
  "scheduleId": "sched-m1n2o3",
  "status": "queued"
}
```

---

### Agents

#### `GET /agents`

List connected agents and their status.

**Response:** `200 OK`

```json
{
  "items": [
    {
      "id": "vps-prod-1",
      "status": "connected",
      "worktreeCount": 4,
      "busyWorktrees": 2,
      "connectedAt": "2026-08-01T08:00:00Z"
    }
  ]
}
```

#### `GET /agents/:id`

Get agent details including worktrees and current sessions.

---

### Providers, Provider Accounts, and Commands

Three global catalogs a session/schedule targets instead of a free-form command string (D4). A **Command** is a name + fixed `argv` + `appendPrompt`, optionally owned by a **Provider** (`providerId: null` = standalone, runs ungated on any worktree). A **Provider** (e.g. `claude`, `codex`) has a `defaultCommandId`. A **Provider Account** is a specific account of a Provider (e.g. an email), attached to one or more hosts; which Command it actually resolves to on a given worktree is a cascade — worktree override → repository override → host-level override/attachment → the provider's own default — walked at session-assign time, not at create time (see [websocket.md](websocket.md) `session:assign`).

All CRUD below is **operator or admin**, and control-plane-only — there's no host-pane equivalent.

#### `POST /providers`

Create a provider. **Does not** create its default command — the control-plane UI's "Add provider" dialog does both in one step (create provider → create its command → `PATCH` `defaultCommandId`) to avoid shipping a provider with no default; scripting this yourself needs the same three calls.

**Request:** `{ "name": "claude" }` (slug: lowercase letters, numbers, dashes)

**Response:** `201 Created` — `{ "id", "name", "defaultCommandId": null, "createdAt", "updatedAt" }`

#### `GET /providers`, `GET /providers/:id`, `PATCH /providers/:id`, `DELETE /providers/:id`

Standard CRUD. `PATCH` body: `{ "name"?, "defaultCommandId"? }` (`defaultCommandId: null` clears it). `DELETE` fails `409` while any Provider Account or Command still references this provider — detach/reassign or delete those first.

#### `POST /provider-accounts`

**Request:** `{ "providerId": "prov-1", "label": "jonathanrichardong@gmail.com" }`

**Response:** `201 Created` — `{ "id", "providerId", "label", "createdAt", "updatedAt" }`. `providerId` must reference an existing provider (`400` otherwise).

#### `GET /provider-accounts`, `GET /provider-accounts/:id`, `PATCH /provider-accounts/:id`, `DELETE /provider-accounts/:id`

Standard CRUD. Deleting an account does **not** detach it from any host that still lists it — that attachment becomes an orphaned reference (soft, no cascade delete).

#### `POST /commands`

**Request:** `{ "name": "claude-print", "argv": ["claude", "-p"], "appendPrompt": true, "resumeArgvTemplate": ["claude", "--resume", "{cliResumeRef}", "{prompt}"], "resumeRefCapture": { "stream": "stdout", "linePrefix": "session id: " }, "providerId": "prov-1" }` (`providerId: null` for standalone)

**Response:** `201 Created` — `{ "id", "name", "argv", "appendPrompt", "resumeArgvTemplate"?, "resumeRefCapture"?, "providerId", "createdAt", "updatedAt" }`. `argv` and `resumeArgvTemplate` are bounded argv arrays — never shell strings. Resume templates must contain exactly one `{cliResumeRef}` and may use `{prompt}`; `resumeRefCapture` contains `stream` (`stdout`, `stderr`, or `either`) and a bounded literal `linePrefix`, never a regular expression.

#### `GET /commands`, `GET /commands/:id`, `PUT /commands/:id`, `DELETE /commands/:id`

Standard CRUD. `providerId` is a **soft** foreign key — the UI filters/suggests by it, but a mismatched value is never hard-blocked. `DELETE` fails `409` while the command is any provider's `defaultCommandId`.

#### `GET /session-targets`

Unified picker source for session/schedule creation: attached Provider Accounts (only ones attached to at least one host — an account that exists in the catalog but isn't attached anywhere is excluded, since it could never resolve to a runnable command) plus standalone Commands.

**Response:** `200 OK`

```json
{
  "items": [
    {
      "kind": "provider-account",
      "id": "acct-1",
      "label": "claude — jonathanrichardong@gmail.com",
      "providerId": "prov-1"
    },
    { "kind": "command", "id": "cmd-1", "label": "echo hello world" }
  ]
}
```

#### Host inventory: attaching a Provider Account

`PUT /agents/:hostId/config` (see [cli.md](cli.md)) carries `providerAccounts: [{ providerAccountId, commandId? }]` — the host-level attachment list, with an optional host-level command override per account. Per-repository and per-worktree overrides (`enabled?`, `commandId?`) live on the corresponding entries inside that same document's `repositories[].providerAccountOverrides` / `repositories[].worktrees[].providerAccountOverrides`.

---
