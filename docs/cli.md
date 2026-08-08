# CLI

Phase 1 local tooling for the agent and API packages. CI callers use the [REST API](api.md) (fire-and-forget); they do not run this CLI.

Full local runbook: [local-development.md](local-development.md). Pre-deploy E2E: [agent-e2e-testing.md](agent-e2e-testing.md).

## Invocation (from monorepo root)

```bash
pnpm install

# Local API first (DynamoDB Local)
pnpm local:dynamodb && pnpm local:dynamodb:ready
pnpm local:api
# → http://127.0.0.1:7420

# Configure host inventory (repos/worktrees) via API — not a local file
curl -fsS -X PUT "http://127.0.0.1:7420/api/v1/agents/local-1/config" \
  -H 'content-type: application/json' \
  -d @examples/local/agent-host.config.json

# A session/schedule targets a Provider Account or a standalone Command from the global
# catalog, not the host config — create one before creating any session:
curl -fsS -X POST "http://127.0.0.1:7420/api/v1/commands" \
  -H 'content-type: application/json' \
  -d '{"name":"echo-prompt","argv":["echo"],"appendPrompt":true,"providerId":null}'

# Agent: identity via env only
export HARNESS_AGENT_ID=local-1
export HARNESS_API_URL=http://127.0.0.1:7420
pnpm local:agent status
pnpm local:agent run-session --file /path/to/session.assign.json

# One-shot create→run verification
pnpm local:e2e
# Documented CLI path (requires local:api)
pnpm local:cli-e2e
```

Agent process env: `HARNESS_AGENT_ID`, `HARNESS_API_URL`, optional `HARNESS_API_KEY` / `HARNESS_LOG_LEVEL`.

---

## Agent commands (Phase 1)

### `status`

Bootstraps host inventory from the control plane, then prints agent id, repositories, worktrees, and attached provider accounts.

```bash
export HARNESS_AGENT_ID=local-1 HARNESS_API_URL=http://127.0.0.1:7420
pnpm local:agent -- status
```

### `run-session`

Run one session from a JSON assign file (see [examples/local/session.assign.json](../examples/local/session.assign.json)).

```bash
pnpm local:agent -- run-session --file ./session.assign.json
```

Required assign fields: `sessionId`, `repositoryId`, `prompt`, `resolvedArgv` (the already-resolved argv — this is the same wire shape the control plane sends over `session:assign`, computed control-plane-side from a Provider Account/Command; the agent never resolves a target itself), `timeout` (seconds), `worktreeId`. Optional: `ref`, `setupScript`, `resume`, `metadata`.

Terminal line is JSON: `{ "status", "exitCode", "errorCode" }`. Exit code `0` only when `status === "completed"`.

### `start`

WebSocket daemon: bootstrap config → register → accept assigns.

```bash
pnpm local:agent start
# optional: --ws ws://127.0.0.1:7420/ws  (otherwise derived from HARNESS_API_URL)
```

---

## API commands (Phase 1)

### `serve`

```bash
pnpm local:api
# optional: node services/api/src/cli.ts serve --port 7420
```

| Method | Path                   | Notes                                                                                                                                                              |
| ------ | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET`  | `/health`              | `{ ok: true }`                                                                                                                                                     |
| `POST` | `/api/v1/sessions`     | body: `repositoryId`, `prompt`, exactly one of `providerAccountId`/`commandId`, `timeout` (+ optional `ref`, labels, …) → `201` with `id`, `status: queued`, `url` |
| `GET`  | `/api/v1/sessions`     | list                                                                                                                                                               |
| `GET`  | `/api/v1/sessions/:id` | get                                                                                                                                                                |

No auto-dispatch to the agent yet — bridge with a session assign file for `run-session`.

---

## Host inventory (API/UI)

Repositories, worktrees, and which Provider Accounts (plus their per-repo/per-worktree enable/command overrides) are available on this host.

```bash
PUT /api/v1/agents/:agentId/config
GET /api/v1/agents/:agentId/config
GET /api/v1/agent-hosts
```

```json
{
  "commandProfiles": {},
  "providerAccounts": [{ "providerAccountId": "acct-1" }],
  "repositories": [
    {
      "id": "demo",
      "path": "/abs/path/to/repo",
      "defaultBranch": "main",
      "terminalHookScript": "/abs/path/hook.sh",
      "worktrees": [
        {
          "id": "wt-1",
          "name": "wt-1",
          "path": "/abs/path/to/repo/.worktrees/wt-1",
          "labels": ["echo"]
        }
      ]
    }
  ]
}
```

`commandProfiles` is still a required field on this document (legacy shape), but nothing resolves
session/schedule commands from it anymore — it's always safe to send `{}`. What a session actually
runs is **named, fixed argv** (D4), resolved from the global Provider/Provider Account/Command
catalogs, not from this document:

```bash
POST /api/v1/providers            # {name} — creates the provider AND its default command
POST /api/v1/provider-accounts    # {providerId, label}
POST /api/v1/commands             # {name, argv, appendPrompt, providerId} — providerId: null for standalone
GET  /api/v1/session-targets      # unified picker: attached provider accounts + standalone commands
```

`POST /api/v1/sessions`/`schedules` then take exactly one of `providerAccountId` (cascade-resolved:
worktree → repository → host → the provider's own default command) or `commandId` (standalone,
ungated). An unknown id is rejected at create time; free-form command strings are never accepted.

Template: [examples/local/agent-host.config.json](../examples/local/agent-host.config.json). Or use the Hosts page in the local web UI.
