# Roles & permissions

What each Auto Harness account may do. Credentials, login, cookies, and host
binding: [auth.md](auth.md). Least privilege and threat model: [security.md](security.md).

The control plane enforces this table. The UI hides write chrome from the same
grants; hiding is not the security boundary.

**Code source of truth:** `modules/shared/src/authz.ts` (`ROLE_CAPABILITIES`,
`USER_ROLE_LABELS`, `effectiveRole`, `accountGrantError`). Path mapping:
`services/api/src/auth-policy.ts` (`requiredCapability`, `authorize`).

When `HARNESS_AUTH_MODE` is not `required` (loopback development), these gates
are off.

---

## Axes

Authorization is three independent axes. Pick **one role**; the other two are
optional filters.

| Axis                   | Stored on                         | Meaning                                                                                                                                 |
| ---------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `role`                 | every account                     | Named grant set. One of the six roles below.                                                                                            |
| `allowedRepositoryIds` | users and service accounts        | If set, the principal only sees and mutates those repositories. Hidden resources fail as `404 NOT_FOUND`. Unset means all repositories. |
| `boundHostId`          | **`agent` service accounts only** | Daemon identity. The key may only inspect or operate that host, and it **cannot author sessions**.                                      |

`kind` (`admin` bootstrap / `user` / `service-account`) is identity, not a
permission. Bootstrap `HARNESS_ADMINS` are unscoped `admin`.

There is no user-facing permission-checkbox UI and no per-command ACL. Session
targets are catalog Provider or Command entries ([plan.md](plan.md) D4).

---

## Roles

UI copy uses the **label**. API, JWT, and DynamoDB store the **id**.

| Id           | UI label    | For                                         | Intent                                                                                                                                                                |
| ------------ | ----------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read-only`  | Read-only   | Humans, reporting keys                      | Observe. No writes.                                                                                                                                                   |
| `author`     | Author      | CI / repo harness keys                      | Mint work: create, clone, resume, archive; cancel **own** sessions. No schedules, no fleet.                                                                           |
| `operator`   | Operator    | Humans running the queue                    | Author + cancel any in-scope session + full schedule CRUD + host drain + repository pause/drain/activate. Not inventory, catalog, or IAM.                             |
| `maintainer` | Maintainer  | Day-2 fleet                                 | Operator + host inventory + provider accounts. Not catalog argv, not IAM, not Slack/audit.                                                                            |
| `agent`      | Host daemon | Host daemon API keys                        | Bound host-daemon identity (`POST /host/messages`, WebSocket, own-host drain). The **only** role allowed to set `boundHostId`. Cannot author sessions.                |
| `admin`      | Admin       | Platform owners, bootstrap `HARNESS_ADMINS` | Everything, including catalog (arbitrary argv / setup scripts), accounts, Slack, audit, scheduler internals. **Must be unscoped** (no repository list, no host bind). |

Humans should not be given `agent`. Service accounts may use any role; daemons
must be `agent`.

---

## Capabilities

Internal grant ids. `GET /api/v1/auth/me` returns them as `capabilities` so the
UI can hide buttons. REST still checks the same ids on every request.

| Capability             | Meaning                                                                                                                                                                                                                       |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| _(authenticated read)_ | Any signed-in principal may `GET` sessions, logs, usage, catalog, hosts, worktrees, schedules, session-targets. Repo/host filters still apply. Not a stored capability — `read-only` has an empty grant list and still reads. |
| `sessions:write`       | `POST /sessions`, clone, resume, cancel (own, unless `sessions:cancel-any`). Bound keys never author; see [Object-level rules](#object-level-rules).                                                                          |
| `sessions:cancel-any`  | Cancel any in-scope session, not only `metadata.createdBy`.                                                                                                                                                                   |
| `sessions:archive`     | `POST /sessions/:id/archive`.                                                                                                                                                                                                 |
| `schedules:write`      | Create, PATCH, trigger, and delete schedules.                                                                                                                                                                                 |
| `fleet:drain`          | `POST /hosts/drain`. Bound principals: own host only.                                                                                                                                                                         |
| `fleet:inventory`      | `PUT`/`DELETE` `/hosts/:id/inventory` and `/host-inventories` (attach repos/worktrees and configure host-scoped setup/hook scripts). **This permits arbitrary execution on the selected host.**                               |
| `providers:accounts`   | Create/update/delete Provider Accounts (capacity pools, not vendor API keys).                                                                                                                                                 |
| `catalog:write`        | Create/update/delete Commands, Providers, and Repositories — including command `argv` and repo `setupScript` / `terminalHookScript`. **This is arbitrary execution on the fleet** ([plan.md](plan.md) D4). Admin only.        |
| `accounts:write`       | User and service-account CRUD, key rotation. `GET` of those lists too.                                                                                                                                                        |
| `integrations:write`   | Slack integration CRUD (`/integrations/slack`), including `GET`.                                                                                                                                                              |
| `audit:read`           | `GET /audit-logs`.                                                                                                                                                                                                            |
| `scheduler:run`        | `POST /scheduler/*` (assign, ack-deadlines, reclaim-stale). Internal.                                                                                                                                                         |
| `agent:protocol`       | `POST /host/messages` and the host WebSocket. Requires `kind=service-account` **and** `boundHostId`.                                                                                                                          |

Unknown `/api/v1` **writes** that are not in this map are denied (fail closed),
including for `admin`.

---

## Grant matrix

✓ = granted. ✗ = denied. “own host” = `boundHostId` must match. Repo scope
still applies to every non-admin row.

| Permission                                                 | `read-only` | `author` | `operator` | `maintainer` | `agent`  | `admin` |
| ---------------------------------------------------------- | :---------: | :------: | :--------: | :----------: | :------: | :-----: |
| Read sessions / logs / usage / catalog / fleet / schedules |      ✓      |    ✓     |     ✓      |      ✓       | own host |    ✓    |
| Create / clone / resume session                            |      ✗      |    ✓     |     ✓      |      ✓       |    ✗     |    ✓    |
| Cancel **own** session                                     |      ✗      |    ✓     |     ✓      |      ✓       |    ✗     |    ✓    |
| Cancel **any** in-scope session                            |      ✗      |    ✗     |     ✓      |      ✓       |    ✗     |    ✓    |
| Archive in-scope session                                   |      ✗      |    ✓     |     ✓      |      ✓       |    ✗     |    ✓    |
| Schedule create / PATCH / trigger / delete                 |      ✗      |    ✗     |     ✓      |      ✓       |    ✗     |    ✓    |
| Drain host                                                 |      ✗      |    ✗     |     ✓      |      ✓       | own host |    ✓    |
| Host inventory write                                       |      ✗      |    ✗     |     ✗      |      ✓       |    ✗     |    ✓    |
| Provider-account write                                     |      ✗      |    ✗     |     ✗      |      ✓       |    ✗     |    ✓    |
| Command / Provider / Repository write                      |      ✗      |    ✗     |     ✗      |      ✗       |    ✗     |    ✓    |
| User + service-account CRUD                                |      ✗      |    ✗     |     ✗      |      ✗       |    ✗     |    ✓    |
| Slack                                                      |      ✗      |    ✗     |     ✗      |      ✗       |    ✗     |    ✓    |
| Audit log read                                             |      ✗      |    ✗     |     ✗      |      ✗       |    ✗     |    ✓    |
| `POST /scheduler/*`                                        |      ✗      |    ✗     |     ✗      |      ✗       |    ✗     |    ✓    |
| `POST /host/messages`                                      |      ✗      |    ✗     |     ✗      |      ✗       |    ✓     |    ✗    |

Stored grant lists (same file as the runtime table):

| Role         | Capabilities                                                                             |
| ------------ | ---------------------------------------------------------------------------------------- |
| `read-only`  | _(none — reads are “any authenticated”)_                                                 |
| `author`     | `sessions:write`, `sessions:archive`                                                     |
| `operator`   | author + `sessions:cancel-any`, `schedules:write`, `repositories:operate`, `fleet:drain` |
| `maintainer` | operator + `fleet:inventory`, `providers:accounts`                                       |
| `agent`      | `agent:protocol`, `fleet:drain`                                                          |
| `admin`      | every capability                                                                         |

`admin` is not granted `agent:protocol` in practice: that grant also requires a
bound service-account, which `admin` is forbidden to be.

---

## REST path map

`authorize()` maps method + path to a capability before the handler runs.

| Path prefix                                                        | GET/HEAD/OPTIONS                       | Writes               |
| ------------------------------------------------------------------ | -------------------------------------- | -------------------- |
| `/api/v1/sessions` (except archive)                                | authenticated                          | `sessions:write`     |
| `/api/v1/sessions/:id/archive`                                     | authenticated                          | `sessions:archive`   |
| `/api/v1/schedules`                                                | authenticated                          | `schedules:write`    |
| `/api/v1/hosts/drain`                                              | authenticated                          | `fleet:drain`        |
| `/api/v1/hosts/:id/inventory`, `/api/v1/host-inventories`          | authenticated                          | `fleet:inventory`    |
| `/api/v1/provider-accounts`                                        | authenticated                          | `providers:accounts` |
| `/api/v1/commands`, `/providers`, `/repositories`                  | authenticated                          | `catalog:write`      |
| `/api/v1/auth/users`, `/auth/service-accounts`                     | `accounts:write`                       | `accounts:write`     |
| `/api/v1/integrations/slack`                                       | `integrations:write`                   | `integrations:write` |
| `/api/v1/audit-logs`                                               | `audit:read`                           | _(no write route)_   |
| `/api/v1/scheduler/*`                                              | —                                      | `scheduler:run`      |
| `/api/v1/host/messages`                                            | —                                      | `agent:protocol`     |
| `/api/v1/auth/me`, `/auth/password`, `/auth/viewer-ticket`, logout | self-service; skipped by `authorize()` | same                 |

Self-service auth routes (`/auth/me`, password change, viewer ticket, logout)
are reachable by any authenticated principal. Login is unauthenticated.

---

## Object-level rules

These run **inside** handlers after the path gate:

| Rule                | Behavior                                                                                                                                                                                                                     |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository scope    | `mayAccessRepository` — missing repository id on a scoped principal is **deny**. Out of scope → `404 NOT_FOUND`.                                                                                                             |
| Host bind           | `mayAccessHost` — bound keys only see their `boundHostId`.                                                                                                                                                                   |
| Session authoring   | `canAuthorSessions` — any `boundHostId` is refused, even if the path gate passed. Create, clone, resume, and schedule writes consult this so a stolen daemon key cannot mint work the scheduler might place on another host. |
| Cancel              | `sessions:cancel-any`, **or** `sessions:write` and `metadata.createdBy === principal.id`. Missing `createdBy` on old rows: only cancel-any.                                                                                  |
| Archive             | Requires `sessions:archive` **and** repo/host access.                                                                                                                                                                        |
| Bound authoring 404 | A bound key that hits session/schedule write routes is allowed through `authorize()` so the handler can return **`404 NOT_FOUND`**, not `403`. A 403 would advertise that those routes exist for this credential.            |

`HARNESS_AUTH_MODE=disabled`: no principal, object-level checks treat that as
allow (local loopback).

---

## Create-time validation

`POST /auth/users` and `POST /auth/service-accounts` run `normalizeAccountGrant()`
(`effectiveRole`) **then** `accountGrantError`. Legacy daemon/scoped-admin shapes
are rewritten to the named role and stored; remaining illegal combinations
return `400 VALIDATION_ERROR`:

| Combination                                                    | Result                                                                 |
| -------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `admin` + `allowedRepositoryIds` or `boundHostId`              | Remapped: scoped admin → `maintainer`, bound admin → `agent`.          |
| `agent` without `boundHostId`                                  | Rejected.                                                              |
| any non-`agent` except `read-only` + `boundHostId`             | Remapped to `agent` so pre-migration daemon keys can still be rotated. |
| `read-only` + `boundHostId`                                    | Rejected (no escalation).                                              |
| `agent` + `allowedRepositoryIds`                               | Allowed (inventory/session reads still filtered).                      |
| `author` / `operator` / `maintainer` / `read-only` + repo list | Allowed.                                                               |

Users accept optional `allowedRepositoryIds` the same way service accounts do.

---

## Legacy mapping

Older rows stored `operator` or `admin` plus a bind or repo list. Those still
authenticate. `effectiveRole()` maps them **at request time** (the stored role
is not rewritten on read). Create and rotate apply the same mapping **before**
grant validation so a deployed daemon key can be replaced:

| Stored                                              | Effective                   |
| --------------------------------------------------- | --------------------------- |
| `read-only`                                         | `read-only`                 |
| `operator`, no bind                                 | `operator`                  |
| `operator` / `admin` / `maintainer` + `boundHostId` | `agent`                     |
| `admin` + `allowedRepositoryIds`, no bind           | `maintainer`                |
| `admin`, unscoped                                   | `admin`                     |
| `read-only` + `boundHostId`                         | `read-only` (no escalation) |

Unbound `operator` keys are **not** downgraded to `author`. Mint a new `author`
key if CI should not rewrite schedules.

`GET /auth/me` returns the **effective** role plus `capabilities`.

---

## What to assign

| Job                                                     | Role         | Scope                     |
| ------------------------------------------------------- | ------------ | ------------------------- |
| Browse the control plane                                | `read-only`  | optional repos            |
| GitHub Actions / repo harness `POST /sessions`          | `author`     | that repository           |
| On-call: cancel anyone’s session, drain, edit schedules | `operator`   | usually unscoped          |
| Attach repos, add worktrees, manage provider accounts   | `maintainer` | optional repos            |
| Host daemon `HARNESS_API_KEY`                           | `agent`      | `boundHostId` = that host |
| Create users/keys, Slack, catalog argv, audit           | `admin`      | none                      |

Every host still needs **two** service accounts: a bound `agent` for the
daemon, and an unbound `author` or `operator` for anything that creates
sessions ([auth.md](auth.md#a-bound-key-cannot-create-sessions)).

Do **not** give `maintainer` or `operator` `catalog:write`. Command argv and
repository setup scripts run on the VPS.

Likewise, give `maintainer` only to operators trusted to run code on managed hosts:
`fleet:inventory` can configure host-, attachment-, and worktree-scoped setup scripts.

---

## UI

Settings role dropdowns show **label — description**. Bound-host field appears
only for `agent`. Catalog/fleet write dialogs, drain, schedule edits, New
session, and session cancel/resume/clone/archive hide unless `/auth/me` has the
matching capability. When auth is disabled, every write control is shown.

The `agent` id is stored on the account; the UI never calls a session or a host
an “agent” ([terminology.md](terminology.md)).

---

## Related

| Doc                              | Role                                      |
| -------------------------------- | ----------------------------------------- |
| [auth.md](auth.md)               | Credentials, login, cookies, host binding |
| [api.md](api.md)                 | REST including account APIs               |
| [security.md](security.md)       | Principles and threat model               |
| [web.md](web.md)                 | Settings / account UI                     |
| [terminology.md](terminology.md) | UI vocabulary                             |
