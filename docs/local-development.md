# Local development

Run and test Auto Harness on your machine **without an AWS account**. Install/prereqs overview: [setup.md](setup.md). Agent CLI details: [cli.md](cli.md). Product sequencing: [plan.md](plan.md).

**Pre-deploy end-to-end (full stack + real CLI):** [host-daemon-e2e-testing.md](host-daemon-e2e-testing.md). **Browser UI E2E (Playwright):** [e2e.md](e2e.md).

## Prerequisites

| Piece                                   | Need                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------ |
| Node.js ≥ 22.18                         | monorepo tooling + **native TypeScript type stripping** (no `tsc` build) |
| pnpm                                    | workspaces (`packageManager` in root `package.json`)                     |
| Docker                                  | **DynamoDB Local** (`amazon/dynamodb-local`)                             |
| Git 2.20+                               | worktrees                                                                |
| AI CLIs (optional for local echo demos) | Codex / Claude / etc. on agent host for real sessions                    |

```bash
pnpm install
```

There is **no compile step**. Scripts and CLIs run TypeScript directly via Node type stripping (`node …/*.ts`).

---

## Local ports (adjacent 7xxx)

Control-plane and host-pane UIs are adjacent (7421/7422) so they're easy to tell apart; DynamoDB Local isn't a browser UI and trails at 7423.

| Service              | Port | URL                     |
| -------------------- | ---- | ----------------------- |
| API (+ `/ws`)        | 7420 | `http://127.0.0.1:7420` |
| **Control-plane UI** | 7421 | `http://127.0.0.1:7421` |
| **Host pane UI**     | 7422 | `http://127.0.0.1:7422` |
| DynamoDB Local       | 7423 | `http://127.0.0.1:7423` |

All three HTTP listeners use loopback by default. Do not expose a local stack
on a LAN interface with `HARNESS_AUTH_MODE=disabled`; startup rejects that
combination. See [auth.md](auth.md#local-authentication-and-public-binds) for
the required public-bind configuration.

`pnpm test:e2e` (Playwright) never touches these — it runs its own stack on `743x`, `+10`
offset, with its own DynamoDB container that gets wiped on every run. See
[e2e.md](e2e.md#how-the-stack-is-started).

---

## DynamoDB Local

Control-plane data uses **Amazon DynamoDB Local** (official image), not a custom in-memory database. Start it before `local:api` / API smoke tests:

```bash
pnpm local:dynamodb
pnpm local:dynamodb:ready   # creates tables, waits for :7423
```

| Item        | Value                                                    |
| ----------- | -------------------------------------------------------- |
| Endpoint    | `HARNESS_DDB_ENDPOINT` (default `http://127.0.0.1:7423`) |
| Compose     | `docker compose` service `dynamodb`                      |
| Credentials | Dummy AWS keys are fine for Local                        |

Stop with `pnpm local:dynamodb:down` (or `docker compose down`).

This is the supported way to **test Auto Harness locally today**. Local deploy/update/teardown: [deploy-local.md](deploy-local.md). Ops index: [deploy.md](deploy.md). Cloud design: [setup.md](setup.md#aws-control-plane-later-phases), [aws.md](aws.md).

---

## Commands cheat sheet

| Command                     | What it does                                                                    |
| --------------------------- | ------------------------------------------------------------------------------- |
| `pnpm local:dynamodb`       | Start DynamoDB Local                                                            |
| `pnpm local:dynamodb:ready` | Wait for endpoint + ensure tables                                               |
| `pnpm local:api`            | Control-plane HTTP (+ `/ws`) on `:7420`                                         |
| `pnpm local:web`            | Control-plane Next.js UI on `:7421`                                             |
| `pnpm local:host-pane`      | Host-pane Next.js UI on `:7422` (`HARNESS_HOST_ID`)                             |
| `pnpm local:daemon`         | Agent CLI (`status`, `run-session`, `start`)                                    |
| `pnpm local:tmux`           | API + both UIs + agent, one tmux window each (DynamoDB Local runs via Docker)   |
| `pnpm local:e2e`            | SessionRunner create→run on a temp git repo                                     |
| `pnpm local:cli-e2e`        | Documented `pnpm local:daemon` path with `ref: main`                            |
| `pnpm local:api-smoke`      | `POST /sessions` → 201                                                          |
| `pnpm local:ws-e2e`         | Real WebSocket create→assign→run                                                |
| `pnpm local:cloud-e2e`      | Loopback agent loop against control plane                                       |
| `pnpm local:manage-verify`  | Repo/schedule CRUD, cancel, drain, web manage routes                            |
| `pnpm check`                | Full local CI gate (lint, fmt, test, knip, depcruise, links, no-mistakes)       |
| `pnpm check:no-mistakes`    | `no-mistakes` rules in `.no-mistakes.yml` (also runs in `pnpm check`)           |
| `pnpm test:e2e`             | Build production UIs + Playwright E2E (`next start`, not dev; [e2e.md](e2e.md)) |

---

## One-shot end-to-end checks

From the repo root after `pnpm install` (and DynamoDB Local for API paths):

```bash
pnpm local:e2e          # SessionRunner create→run
pnpm local:cli-e2e      # documented agent CLI + ref main
pnpm local:ws-e2e       # real WebSocket agent channel
pnpm local:cloud-e2e    # loopback agent loop
```

What `local:e2e` does (real shipped modules):

1. Creates a temporary git repo with branch `feature/local-e2e`
2. Creates a session via the **local API create path** (`createLocalApp` / `POST /api/v1/sessions` handler)
3. Asserts an **unknown target `commandId`** is rejected at create time (no shell fallback) — see target validation
4. Runs `SessionRunner` against a real `echo` standalone Command, with `ref: feature/local-e2e`
5. Asserts worktree `HEAD` matches that feature commit, terminal hook env was set, and log `seq` is monotonic

Expect JSON with `"ok": true` and `"status": "completed"`.

---

## Manual path A — configure host inventory, then `run-session`

Agent identity is **env only**. Host inventory (paths, worktrees, attached Provider Accounts) lives on the control plane; the Command/Provider catalog is separate and global.

1. Start DynamoDB Local and the API:

```bash
pnpm local:dynamodb && pnpm local:dynamodb:ready
pnpm local:api
# http://127.0.0.1:7420
```

2. PUT host inventory (edit absolute paths; template [examples/local/host-inventory.config.json](../examples/local/host-inventory.config.json)):

```bash
curl -fsS -X PUT http://127.0.0.1:7420/api/v1/hosts/local-1/inventory \
  -H 'content-type: application/json' \
  -d @examples/local/host-inventory.config.json
# or use the Hosts page: HARNESS_API_HTTP=http://127.0.0.1:7420 pnpm local:web → /hosts
```

**Body fields:** `providerAccounts[]` (attached Provider Accounts, optionally with a host-level command override), `repositories[]` with `id`, `path`, `worktrees[]`.

3. `run-session --file` reads a `SessionAssign` JSON with an already-resolved `resolvedArgv` (see [examples/local/session.assign.json](../examples/local/session.assign.json)) — this bypasses the control plane's own Provider/Command resolution entirely (useful for testing `SessionRunner` in isolation), so there's no catalog setup needed for this specific path.

4. Run with env identity (a leading `--` from pnpm is stripped):

```bash
export HARNESS_HOST_ID=local-1
export HARNESS_API_URL=http://127.0.0.1:7420
pnpm local:daemon status
pnpm local:daemon run-session --file /path/to/session.assign.json
pnpm local:daemon -- status
```

On success the CLI prints a final JSON line with `"status":"completed"`. On failure (setup error, timeout, usage limit) status is non-completed and exit code is non-zero.

More command detail: [cli.md](cli.md).

---

## Manual path B — local API create, then agent run

1. Start DynamoDB Local (if not already), then the API, and PUT host inventory as in path A.

2. Create a standalone Command (once) and a session targeting it (fire-and-forget style):

```bash
CMD=$(curl -sS -X POST http://127.0.0.1:7420/api/v1/commands \
  -H 'content-type: application/json' \
  -d '{"name":"echo-prompt","argv":["echo"],"appendPrompt":true,"providerId":null}')
CMD_ID=$(printf '%s' "$CMD" | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>console.log(JSON.parse(s).id))")

curl -sS -X POST http://127.0.0.1:7420/api/v1/sessions \
  -H 'content-type: application/json' \
  -d "{
    \"repositoryId\": \"demo\",
    \"prompt\": \"hello from API\",
    \"target\": { \"commandId\": \"$CMD_ID\" },
    \"queueTtlSeconds\": 691200,
    \"timeout\": 60,
    \"ref\": \"main\",
    \"requiredLabels\": [\"echo\"]
  }"
```

Response `201` includes `id`, `status: "queued"`, `url`, `targetLabel`, `created: true`, and the fields you sent. If the request includes an active matching `concurrencyId`, the API instead returns `200` with the existing session and `created: false`; terminal sessions release the identity for retry. Copy `id` into a session assign JSON as `sessionId`, set `worktreeId` from host inventory, then:

```bash
export HARNESS_HOST_ID=local-1 HARNESS_API_URL=http://127.0.0.1:7420
pnpm local:daemon -- run-session --file /path/to/session.assign.json
```

> The local API begins an EventBridge-equivalent scheduler sweep on startup and repeats it every minute. It evaluates cron, reclaims stale hosts, enforces ACK deadlines, and dispatches queued sessions over the real `/ws` channel. The `POST /scheduler/*` routes remain available when an operator needs to force a sweep.

---

## Local web UIs (two Next.js apps)

Issue [#2](https://github.com/jonathanong/auto-harness/issues/2): **Next.js** for both panes, shared `@auto-harness/ui` (shadcn-style), client navigation (no full reloads), filters/state in the URL.

| UI            | Port | Command                | Role                                                     |
| ------------- | ---- | ---------------------- | -------------------------------------------------------- |
| Control plane | 7421 | `pnpm local:web`       | Dashboard, sessions, repos, schedules, agent **fleet**   |
| Host pane     | 7422 | `pnpm local:host-pane` | **This agent**: status, worktrees, host inventory, drain |

Shared components: `modules/ui`.

```bash
pnpm local:dynamodb && pnpm local:dynamodb:ready
pnpm local:api         # :7420
pnpm local:web         # :7421 control plane
pnpm local:host-pane   # :7422 host pane
pnpm local:daemon start # registers even with no repos yet
```

Or start everything above (except DynamoDB Local, which runs in Docker) in one tmux session — one window each: `pnpm local:tmux`.

**Intended flow**

1. Start API + agent (+ optional UIs). Agent uses env defaults (`local-1` → `:7420`) and **registers online** with empty inventory.
2. **Register the repository in the catalog** (once): Control pane: http://127.0.0.1:7421/repositories → **Add repository** (name + url; id is auto-generated).
3. **Attach it to a host** (either place does the same thing — pick the catalog repo, give a local path):
   - Control pane: http://127.0.0.1:7421/repositories → **Attach a repository to a host**
   - Host pane: http://127.0.0.1:7422/repositories → **Add repository**
4. **Register a Provider/Command target** (once): http://127.0.0.1:7421/commands → **Add command** (standalone, e.g. `echo`), or http://127.0.0.1:7421/providers → **Add provider** for a real CLI (creates its default command in the same step) → attach an account to the host on its detail page's Provider accounts tab.
5. Agent polls inventory (~15s) and re-registers worktrees; then create a session (picking the target from step 4 — http://127.0.0.1:7421/sessions/new — or via `POST /sessions`). The local scheduler dispatches it on its next sweep (within one minute). `POST /scheduler/assign` is still useful to force a manual sweep.

Local defaults: `HARNESS_HOST_ID=local-1`, `HARNESS_API_URL`/`HARNESS_API_HTTP=http://127.0.0.1:7420`.

---

## Operator management (local REST)

With `pnpm local:api` (and DynamoDB Local) running, REST under `/api/v1` supports:

| Resource                                 | Routes                                                                                                                               |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Repositories                             | `GET/POST /repositories`, `GET/PUT/DELETE /repositories/:id`                                                                         |
| Schedules                                | `GET/POST /schedules`, `GET/PUT/DELETE /schedules/:id`, `POST /schedules/:id/trigger`                                                |
| Sessions                                 | `GET /sessions`, `POST /sessions/:id/cancel`                                                                                         |
| Hosts                                    | `GET /hosts`, `POST /hosts/drain`; `GET/PUT/DELETE /hosts/:hostId/inventory`                                                         |
| Providers / Provider Accounts / Commands | `GET/POST /providers`, `/provider-accounts`, `/commands` (+ `GET/PUT/DELETE .../:id`); `GET /session-targets` for the unified picker |

Also available: worktrees, scheduler helpers, session logs/resume/archive — see [api.md](api.md) and [cli.md](cli.md) for the Phase 1 surface.

Verify management paths:

```bash
pnpm local:manage-verify
```

---

## Quality gate

```bash
pnpm check
pnpm local:e2e            # create handler + SessionRunner (feature ref)
pnpm local:cli-e2e        # documented `pnpm local:daemon` path with ref: main
pnpm local:api-smoke      # POST /sessions → 201
pnpm local:ws-e2e         # WebSocket create→assign→run
pnpm local:manage-verify  # repo/schedule CRUD, cancel, drain, web manage routes
# optional UI: pnpm local:web
```

`pnpm check` runs oxlint, oxfmt, vitest — both the unit project (**100%** coverage on `modules/*/src` and `services/*/src`, excluding pure type files and thin CLIs) and the integration project (`integration/`, no coverage gate of its own) — the Dynamo adapter verifier, knip, dependency-cruiser, lychee, and [`no-mistakes`](https://github.com/jonathanong/no-mistakes).

`pnpm check:no-mistakes` (`pnpm check:data-pw` is an alias) runs the root `.no-mistakes.yml`. That config binds the `control` and `host-pane` Playwright projects to `services/web` and `services/host-pane` so selector coverage stays app-scoped, then checks Playwright `data-pw` uniqueness/coverage, prefers test-id locators, bans control-plane Next.js API routes and Next.js caching, and enforces repo hygiene (pnpm-only lockfile, workspace package coverage, registry-only deps, `AGENTS.md` size, no empty files, no `.js`/`.jsx` under `modules/`/`services/`, no workspace package cycles, valid Mermaid, no mocks in `integration/`). `frontendRoot`/`selectorRoots` stay explicit so `src/app` route detection and `src/components` selector coverage cannot silently regress.

---

## Runtime notes

- **No `tsc` / no `tsx` build.** Execute with Node ≥ 22.18 type stripping.
- Relative TypeScript imports use **`.ts` extensions**.
- Avoid TS features Node cannot strip (enums, namespaces, parameter properties).
- **D4:** only named, catalog-resolved Provider Accounts/Commands — never free-form shell command strings over the API.
- Secrets stay on the agent host (git + AI CLIs); not in REST session bodies. See [security.md](security.md), [auth.md](auth.md).

---

## Related

| Doc                                | Role                                      |
| ---------------------------------- | ----------------------------------------- |
| [setup.md](setup.md)               | Install overview                          |
| [deploy.md](deploy.md)             | Deploy index (local / AWS / agent)        |
| [deploy-local.md](deploy-local.md) | Local deploy / update / teardown          |
| [cli.md](cli.md)                   | Agent/API CLI commands                    |
| [terminology.md](terminology.md)   | UI-facing vocabulary (Host, Session, ...) |
| [api.md](api.md)                   | REST shapes                               |
| [websocket.md](websocket.md)       | Agent + UI real-time protocol             |
| [host-daemon.md](host-daemon.md)   | Agent internals                           |
| [aws.md](aws.md)                   | Control-plane design                      |
| [plan.md](plan.md)                 | Phases and acceptance criteria            |
