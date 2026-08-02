# Setup

Install and run Auto Harness. Design details: [aws.md](aws.md), [agent.md](agent.md), [plan.md](plan.md).

## Prerequisites

| Piece                                   | Need                                                  |
| --------------------------------------- | ----------------------------------------------------- |
| Node.js 22+                             | monorepo tooling                                      |
| pnpm                                    | workspaces (`packageManager` in root `package.json`)  |
| Git 2.20+                               | worktrees                                             |
| AI CLIs (optional for local echo demos) | Codex / Claude / etc. on agent host for real sessions |

---

## Local development (Phase 1 — no AWS)

This is the supported way to **test Auto Harness locally today**. Cloud WebSocket `start`, DynamoDB, and the web UI come in later phases.

### One-shot end-to-end check

From the repo root after `pnpm install`:

```bash
pnpm local:e2e
```

What it does (real shipped modules):

1. Creates a temporary git repo with branch `feature/local-e2e`
2. Creates a session via the **local API create path** (`createLocalApp` / `POST /api/v1/sessions` handler)
3. Asserts an **unknown `commandProfile`** fails with `errorCode: unknown_command_profile` (no shell fallback)
4. Runs `SessionRunner` with `ref: feature/local-e2e` and profile `echo-prompt`
5. Asserts worktree `HEAD` matches that feature commit, terminal hook env was set, and log `seq` is monotonic

Expect JSON with `"ok": true` and `"status": "completed"`.

### Manual path A — agent `run-session` only

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

### Manual path B — local API create, then agent run

1. Start the local API (in-memory store, no DynamoDB):

```bash
pnpm local:api
# listens on http://127.0.0.1:7420
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

> Phase 1 does **not** yet auto-dispatch API sessions to the agent over WebSocket (`start` is Phase 3). You bridge create → run with the assign file (or use `pnpm local:e2e`, which does both in-process).

### Quality gate

```bash
pnpm check
pnpm local:e2e        # create handler + SessionRunner (feature ref)
pnpm local:cli-e2e    # documented `pnpm local:agent` path with ref: main
pnpm local:api-smoke  # POST /sessions → 201
```

`pnpm check` runs typecheck, oxlint, oxfmt, vitest (**100%** coverage on `modules/*/src` and `services/*/src`, excluding pure type files and thin CLIs), knip, dependency-cruiser, and lychee.

---

## AWS control plane (later phases)

1. `pnpm install`
2. Configure secrets (do not commit):
   - `HARNESS_ADMINS` — base64 JSON `[{ "username", "password" }]`
   - `HARNESS_SESSION_SECRET` — long random string for UI JWTs
   - `WEB_ORIGIN` — browser origin for CORS
3. Deploy: `pnpm --filter @auto-harness/cdk deploy` (when CDK is implemented)
4. Create users / service accounts; bind agent API key; add repositories

See [aws.md](aws.md), [security.md](security.md).

---

## VPS agent (production shape)

Production will use WebSocket `start` (Phase 3). Until then, use local `run-session` above.

Agent config still includes optional `apiUrl` / `apiKey` for later cloud connect. **commandProfiles** stay required for all execution (D4).

Subscription CLIs and secrets live only on the host — see [why.md](why.md), [costs.md](costs.md).

Env vars:

| Variable              | Required  | Default                            |
| --------------------- | --------- | ---------------------------------- |
| `HARNESS_CONFIG_PATH` | no        | `./auto-harness-agent.config.json` |
| `HARNESS_AGENT_ID`    | no        | config / hostname                  |
| `HARNESS_API_URL`     | for cloud | config `apiUrl`                    |
| `HARNESS_API_KEY`     | for cloud | config `apiKey`                    |
| `HARNESS_LOG_LEVEL`   | no        | `info`                             |

---

## Security reminders

- No secrets in prompts or REST session bodies
- Agent holds git + AI credentials on the VPS
- Free-form shell commands are not accepted over the API — only named `commandProfile`s

See [security.md](security.md).
