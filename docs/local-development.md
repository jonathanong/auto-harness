# Local development

Run and test Auto Harness on your machine **without an AWS account**. Install/prereqs overview: [setup.md](setup.md). Agent CLI details: [cli.md](cli.md). Product sequencing: [plan.md](plan.md).

**Pre-deploy end-to-end (full stack + real CLI):** [agent-e2e-testing.md](agent-e2e-testing.md).

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

## DynamoDB Local

Control-plane data uses **Amazon DynamoDB Local** (official image), not a custom in-memory database. Start it before `local:api` / API smoke tests:

```bash
pnpm local:dynamodb
pnpm local:dynamodb:ready   # creates tables, waits for :8000
```

| Item        | Value                                                    |
| ----------- | -------------------------------------------------------- |
| Endpoint    | `HARNESS_DDB_ENDPOINT` (default `http://127.0.0.1:8000`) |
| Compose     | `docker compose` service `dynamodb`                      |
| Credentials | Dummy AWS keys are fine for Local                        |

Stop with `pnpm local:dynamodb:down` (or `docker compose down`).

This is the supported way to **test Auto Harness locally today**. Cloud WebSocket `start` and full AWS deploy are documented separately ([setup.md](setup.md#aws-control-plane-later-phases), [aws.md](aws.md)).

---

## Commands cheat sheet

| Command                     | What it does                                                 |
| --------------------------- | ------------------------------------------------------------ |
| `pnpm local:dynamodb`       | Start DynamoDB Local                                         |
| `pnpm local:dynamodb:ready` | Wait for endpoint + ensure tables                            |
| `pnpm local:api`            | Control-plane HTTP (+ `/ws`) on `:7420`                      |
| `pnpm local:web`            | Thin manage UI on `:3000`                                    |
| `pnpm local:agent`          | Agent CLI (`status`, `run-session`, later `start`)           |
| `pnpm local:e2e`            | SessionRunner create→run on a temp git repo                  |
| `pnpm local:cli-e2e`        | Documented `pnpm local:agent` path with `ref: main`          |
| `pnpm local:api-smoke`      | `POST /sessions` → 201                                       |
| `pnpm local:ws-e2e`         | Real WebSocket create→assign→run                             |
| `pnpm local:cloud-e2e`      | Loopback agent loop against control plane                    |
| `pnpm local:manage-verify`  | Repo/schedule CRUD, cancel, drain, web manage routes         |
| `pnpm check`                | Full local CI gate (lint, fmt, test, knip, depcruise, links) |

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
3. Asserts an **unknown `commandProfile`** fails with `errorCode: unknown_command_profile` (no shell fallback)
4. Runs `SessionRunner` with `ref: feature/local-e2e` and profile `echo-prompt`
5. Asserts worktree `HEAD` matches that feature commit, terminal hook env was set, and log `seq` is monotonic

Expect JSON with `"ok": true` and `"status": "completed"`.

---

## Manual path A — agent `run-session` only

No API required. Good for iterating on the agent runner and worktree checkout.

1. Point example config at a real absolute repo path (see [examples/local/agent.config.json](../examples/local/agent.config.json)):

```json
{
  "agentId": "local-1",
  "commandProfiles": {
    "echo-prompt": { "argv": ["echo"], "appendPrompt": true }
  },
  "repositories": [
    {
      "id": "demo",
      "path": "/ABS/PATH/TO/REPO",
      "defaultBranch": "main",
      "worktrees": [
        {
          "id": "wt-1",
          "path": "/ABS/PATH/TO/REPO/.worktrees/wt-1",
          "labels": ["echo"]
        }
      ]
    }
  ]
}
```

**Required fields:** `agentId`, `commandProfiles` (named → fixed `argv`, never free-form shell), `repositories[]` with `id`, `path`, `worktrees[]`.

2. Write a session assign file (see [examples/local/session.assign.json](../examples/local/session.assign.json)):

```json
{
  "sessionId": "sess-local-1",
  "repositoryId": "demo",
  "prompt": "hello from local session",
  "commandProfile": "echo-prompt",
  "timeout": 60,
  "worktreeId": "wt-1",
  "ref": "main"
}
```

3. Run (either form works; a leading `--` from pnpm is stripped):

```bash
pnpm local:agent status --config /path/to/agent.config.json
pnpm local:agent run-session --config /path/to/agent.config.json --file /path/to/session.assign.json

# also valid:
pnpm local:agent -- status --config /path/to/agent.config.json
pnpm local:agent -- run-session --config /path/to/agent.config.json --file /path/to/session.assign.json
```

On success the CLI prints a final JSON line with `"status":"completed"`. On failure (unknown profile, setup error, timeout, usage limit) status is non-completed and exit code is non-zero.

More command detail: [cli.md](cli.md).

---

## Manual path B — local API create, then agent run

1. Start DynamoDB Local (if not already), then the API:

```bash
pnpm local:dynamodb && pnpm local:dynamodb:ready
pnpm local:api
# listens on http://127.0.0.1:7420 — persists sessions to DynamoDB Local
```

2. Create a session (fire-and-forget style):

```bash
curl -sS -X POST http://127.0.0.1:7420/api/v1/sessions \
  -H 'content-type: application/json' \
  -d '{
    "repositoryId": "demo",
    "prompt": "hello from API",
    "commandProfile": "echo-prompt",
    "timeout": 60,
    "ref": "main",
    "requiredLabels": ["echo"]
  }'
```

Response `201` includes `id`, `status: "queued"`, `url`, and the fields you sent. Copy `id` into a session assign JSON as `sessionId`, set `worktreeId` from your agent config, then:

```bash
pnpm local:agent -- run-session --config /path/to/agent.config.json --file /path/to/session.assign.json
```

> Local API create does **not** always auto-dispatch over WebSocket for every workflow. Bridge create → run with the assign file, use `pnpm local:e2e` (in-process), or `pnpm local:ws-e2e` for the real `/ws` agent channel.

---

## Local web UI

```bash
pnpm local:dynamodb && pnpm local:dynamodb:ready
pnpm local:api    # :7420
pnpm local:web    # :3000 — create-session + manage pages
```

Open `http://127.0.0.1:3000`. Surfaces include new session (command profile dropdown of agent-reported names only — D4), sessions list + cancel, repositories, schedules (create/trigger), and agents (drain).

---

## Operator management (local REST)

With `pnpm local:api` (and DynamoDB Local) running, REST under `/api/v1` supports:

| Resource     | Routes                                                                                |
| ------------ | ------------------------------------------------------------------------------------- |
| Repositories | `GET/POST /repositories`, `GET/PUT/DELETE /repositories/:id`                          |
| Schedules    | `GET/POST /schedules`, `GET/PUT/DELETE /schedules/:id`, `POST /schedules/:id/trigger` |
| Sessions     | `GET /sessions`, `POST /sessions/:id/cancel`                                          |
| Agents       | `GET /agents`, `POST /agents/drain`                                                   |

Also available: command profiles, worktrees, scheduler helpers, session logs/resume/archive — see [api.md](api.md) and [cli.md](cli.md) for the Phase 1 surface.

Verify management paths:

```bash
pnpm local:manage-verify
```

---

## Quality gate

```bash
pnpm check
pnpm local:e2e            # create handler + SessionRunner (feature ref)
pnpm local:cli-e2e        # documented `pnpm local:agent` path with ref: main
pnpm local:api-smoke      # POST /sessions → 201
pnpm local:ws-e2e         # WebSocket create→assign→run
pnpm local:manage-verify  # repo/schedule CRUD, cancel, drain, web manage routes
# optional UI: pnpm local:web
```

`pnpm check` runs oxlint, oxfmt, vitest (**100%** coverage on `modules/*/src` and `services/*/src`, excluding pure type files and thin CLIs), knip, dependency-cruiser, and lychee.

---

## Runtime notes

- **No `tsc` / no `tsx` build.** Execute with Node ≥ 22.18 type stripping.
- Relative TypeScript imports use **`.ts` extensions**.
- Avoid TS features Node cannot strip (enums, namespaces, parameter properties).
- **D4:** only named `commandProfile`s — never free-form shell command strings over the API.
- Secrets stay on the agent host (git + AI CLIs); not in REST session bodies. See [security.md](security.md), [auth.md](auth.md).

---

## Related

| Doc                          | Role                                      |
| ---------------------------- | ----------------------------------------- |
| [setup.md](setup.md)         | Install, AWS deploy, VPS agent production |
| [cli.md](cli.md)             | Agent/API CLI commands                    |
| [api.md](api.md)             | REST shapes                               |
| [websocket.md](websocket.md) | Agent + UI real-time protocol             |
| [agent.md](agent.md)         | Agent internals                           |
| [aws.md](aws.md)             | Control-plane design                      |
| [plan.md](plan.md)           | Phases and acceptance criteria            |
