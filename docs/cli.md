# CLI

Phase 1 local tooling for the agent and API packages. CI callers use the [REST API](api.md) (fire-and-forget); they do not run this CLI.

Full local runbook: [setup.md](setup.md#local-development-phase-1--no-aws).

## Invocation (from monorepo root)

```bash
pnpm install

# Agent
pnpm local:agent -- status --config /path/to/agent.config.json
pnpm local:agent -- run-session --config /path/to/agent.config.json --file /path/to/session.assign.json

# Local API (in-memory)
pnpm local:api
# → http://127.0.0.1:7420

# One-shot create→run verification
pnpm local:e2e
```

Config defaults to `./auto-harness-agent.config.json`. Override with `--config` or `HARNESS_CONFIG_PATH`.

---

## Agent commands (Phase 1)

### `status`

Print agent id, repositories, worktrees, and known `commandProfiles`.

```bash
pnpm local:agent -- status --config ./agent.config.json
```

### `run-session`

Run one session from a JSON assign file (see [examples/local/session.assign.json](../examples/local/session.assign.json)).

```bash
pnpm local:agent -- run-session --config ./agent.config.json --file ./session.assign.json
```

Required assign fields: `sessionId`, `repositoryId`, `prompt`, `commandProfile`, `timeout` (seconds), `worktreeId`. Optional: `ref`, `setupScript`, `resume`, `metadata`.

Terminal line is JSON: `{ "status", "exitCode", "errorCode" }`. Exit code `0` only when `status === "completed"`.

### `start`

WebSocket daemon (register + accept assigns) — **not implemented until Phase 3**. Use `run-session` or `pnpm local:e2e` locally.

---

## API commands (Phase 1)

### `serve`

```bash
pnpm local:api
# optional: tsx services/api/src/cli.ts serve --port 7420
```

| Method | Path                   | Notes                                                                                                                                |
| ------ | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `GET`  | `/health`              | `{ ok: true }`                                                                                                                       |
| `POST` | `/api/v1/sessions`     | body: `repositoryId`, `prompt`, `commandProfile`, `timeout` (+ optional `ref`, labels, …) → `201` with `id`, `status: queued`, `url` |
| `GET`  | `/api/v1/sessions`     | list                                                                                                                                 |
| `GET`  | `/api/v1/sessions/:id` | get                                                                                                                                  |

No auto-dispatch to the agent yet — bridge with a session assign file for `run-session`.

---

## Config shape (agent)

Named **command profiles** are required (D4). Free-form command strings are rejected.

```json
{
  "agentId": "local-1",
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
        { "id": "wt-1", "path": "/abs/path/to/repo/.worktrees/wt-1", "labels": ["echo"] }
      ]
    }
  ]
}
```

Templates: [examples/local/](../examples/local/).
