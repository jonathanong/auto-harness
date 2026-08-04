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

# Configure host inventory (repos/worktrees/profiles) via API — not a local file
curl -fsS -X PUT "http://127.0.0.1:7420/api/v1/agents/local-1/config" \
  -H 'content-type: application/json' \
  -d @examples/local/agent-host.config.json

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

Bootstraps host inventory from the control plane, then prints agent id, repositories, worktrees, and `commandProfiles`.

```bash
export HARNESS_AGENT_ID=local-1 HARNESS_API_URL=http://127.0.0.1:7420
pnpm local:agent -- status
```

### `run-session`

Run one session from a JSON assign file (see [examples/local/session.assign.json](../examples/local/session.assign.json)).

```bash
pnpm local:agent -- run-session --file ./session.assign.json
```

Required assign fields: `sessionId`, `repositoryId`, `prompt`, `commandProfile`, `timeout` (seconds), `worktreeId`. Optional: `ref`, `setupScript`, `resume`, `metadata`.

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

| Method | Path                   | Notes                                                                                                                                |
| ------ | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `GET`  | `/health`              | `{ ok: true }`                                                                                                                       |
| `POST` | `/api/v1/sessions`     | body: `repositoryId`, `prompt`, `commandProfile`, `timeout` (+ optional `ref`, labels, …) → `201` with `id`, `status: queued`, `url` |
| `GET`  | `/api/v1/sessions`     | list                                                                                                                                 |
| `GET`  | `/api/v1/sessions/:id` | get                                                                                                                                  |

No auto-dispatch to the agent yet — bridge with a session assign file for `run-session`.

---

## Host inventory (API/UI)

Named **command profiles** are required (D4). Free-form command strings are rejected.

```bash
PUT /api/v1/agents/:agentId/config
GET /api/v1/agents/:agentId/config
GET /api/v1/agent-hosts
```

```json
{
  "commandProfiles": {
    "echo-prompt": { "argv": ["echo"], "appendPrompt": true }
  },
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

Template: [examples/local/agent-host.config.json](../examples/local/agent-host.config.json). Or use the Hosts page in the local web UI.
