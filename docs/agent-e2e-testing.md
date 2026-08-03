# Agent E2E testing (local, pre-deploy)

**Audience:** coding agents (and humans) validating Auto Harness **locally** before any cloud deploy.

**Bar:** the full control-plane + agent + (optional) web path works with **real** DynamoDB Local, **real** HTTP/WS, **real** git worktrees, and a **real non-interactive CLI** profile (e.g. `grok`, `codex`, or `echo` for a dry run). Do not claim “ready to deploy” after unit tests alone.

Related: [local-development.md](local-development.md) (runbook), [deploy-local.md](deploy-local.md) (local ops), [deploy.md](deploy.md) (ops index), [cli.md](cli.md) (agent CLI), [api.md](api.md) (REST), [websocket.md](websocket.md), [plan.md](plan.md) (acceptance criteria).

---

## 0. Preconditions

| Need            | Check                                                  |
| --------------- | ------------------------------------------------------ |
| Node.js ≥ 22.18 | `node -v`                                              |
| pnpm            | `pnpm -v` (see root `packageManager`)                  |
| Docker          | for DynamoDB Local                                     |
| Git ≥ 2.20      | worktrees                                              |
| Optional AI CLI | `which grok` / `which codex` / etc. for a real profile |

```bash
cd /path/to/auto-harness
pnpm install
```

There is **no `tsc` build**. Runtime is Node type stripping (`node …/*.ts`).

---

## 1. Automated gates (must pass first)

Run from repo root. These exercise **shipped** scripts and modules — not re-implementations.

```bash
pnpm check                 # lint, fmt, tests+coverage, knip, depcruise, links
pnpm local:dynamodb
pnpm local:dynamodb:ready
pnpm local:e2e             # SessionRunner + ref + unknown profile + hooks
pnpm local:cli-e2e         # documented pnpm local:agent run-session (ref: main)
pnpm local:api-smoke       # POST /sessions → 201 queued
pnpm local:ws-e2e          # real WebSocket create→assign→run
pnpm local:cloud-e2e       # AgentLoop loopback
pnpm local:manage-verify   # repos/schedules/cancel/drain + thin web routes
```

**Pass criteria (each):** exit 0; JSON includes `"ok": true` and/or documented HTTP status (`201` for smoke).

If any gate fails, **stop** and fix before manual stack testing.

---

## 2. Clean DynamoDB Local state

Leftover queued sessions from prior smokes will steal worktree assigns (scheduler walks the whole queue). Before a manual E2E, clear the default tables:

```bash
export HARNESS_DDB_ENDPOINT=http://127.0.0.1:8000
export AWS_ACCESS_KEY_ID=local
export AWS_SECRET_ACCESS_KEY=local
export AWS_REGION=us-east-1

node --input-type=module <<'EOF'
import { createControlPlane } from "./services/api/src/create-plane.ts";
const { storage } = await createControlPlane({
  tablePrefix: "AutoHarness",
  publicBaseUrl: "http://127.0.0.1:3000",
});
await storage.clearAll();
console.log(JSON.stringify({ ok: true, cleared: "AutoHarness" }));
EOF
```

Confirm nothing is listening on the ports you need (or stop prior processes):

```bash
lsof -iTCP:7420 -sTCP:LISTEN || true
lsof -iTCP:3000 -sTCP:LISTEN || true
```

---

## 3. Demo workspace + agent config

Create a **throwaway** git repo and worktree paths with **absolute** paths (agent config does not expand `~`).

```bash
WORK="$PWD/.local-agent-e2e"   # gitignored pattern: prefer under .local-* or /tmp
rm -rf "$WORK"
mkdir -p "$WORK/repo" "$WORK/worktrees/wt-1" "$WORK/config" "$WORK/logs"

cd "$WORK/repo"
git init -b main
git config user.email "e2e@auto-harness.local"
git config user.name "Auto Harness E2E"
echo '# e2e' > README.md
echo 'console.log("hi");' > app.js
git add . && git commit -m "init"

# Resolve a real CLI binary if you have one
GROK_BIN="$(command -v grok || true)"
CODEX_BIN="$(command -v codex || true)"
```

### Command profiles (D4)

Profiles are **named → fixed argv**. Never put free-form shell strings in the API. Prefer a dry-run profile plus one real CLI:

| Profile                      | Purpose                                                      |
| ---------------------------- | ------------------------------------------------------------ |
| `echo-prompt`                | Always available; proves assign/checkout/logs without AI     |
| `grok-print` / `codex-print` | Real non-interactive CLI (optional but preferred pre-deploy) |

**Grok** (headless single-turn — flags verified against `grok --help`):

```json
"grok-print": {
  "argv": ["/ABS/PATH/TO/grok", "--always-approve", "--max-turns", "3", "--output-format", "plain", "-p"],
  "appendPrompt": true
}
```

With `appendPrompt: true`, the session prompt is appended as the final argv element (so `-p` receives the prompt).

Write config (substitute absolute paths):

```bash
# From monorepo root after setting WORK / GROK_BIN
cat > "$WORK/config/agent.config.json" <<EOF
{
  "agentId": "local-e2e-1",
  "apiUrl": "http://127.0.0.1:7420",
  "logLevel": "info",
  "commandProfiles": {
    "echo-prompt": {
      "argv": ["echo"],
      "appendPrompt": true
    },
    "grok-print": {
      "argv": ["${GROK_BIN:-/usr/bin/false}", "--always-approve", "--max-turns", "3", "--output-format", "plain", "-p"],
      "appendPrompt": true
    }
  },
  "repositories": [
    {
      "id": "demo",
      "path": "$WORK/repo",
      "defaultBranch": "main",
      "worktrees": [
        {
          "id": "wt-1",
          "path": "$WORK/worktrees/wt-1",
          "labels": ["echo", "grok"]
        }
      ]
    }
  ]
}
EOF
```

If `grok` is not installed, **omit** `grok-print` and only run the echo profile — still required for assign/WS proof. Document that a real CLI was skipped.

Validate config:

```bash
pnpm local:agent status --config "$WORK/config/agent.config.json"
# expect agentId, repositories, commandProfiles including the profiles you defined
```

---

## 4. Bring up the stack

Three long-running processes + DynamoDB. Prefer separate terminals or backgrounded logs under `$WORK/logs`.

```bash
# Terminal A — DynamoDB (once)
pnpm local:dynamodb
pnpm local:dynamodb:ready

# Terminal B — API (:7420, REST + /ws)
pnpm local:api
# → Auto Harness local API listening on http://127.0.0.1:7420

# Terminal C — Web (optional, :3000)
HARNESS_API_HTTP=http://127.0.0.1:7420 pnpm local:web

# Terminal D — Agent daemon
pnpm local:agent start \
  --config "$WORK/config/agent.config.json" \
  --ws ws://127.0.0.1:7420/ws
# → connected … / agent … registered
```

**Health checks:**

```bash
curl -sS http://127.0.0.1:7420/health
# {"ok":true}

curl -sS http://127.0.0.1:7420/api/v1/agents
# items include agentId, online:true, commandProfiles, worktreeIds

curl -sS http://127.0.0.1:7420/api/v1/command-profiles
# items list agent-reported names only (e.g. echo-prompt, grok-print)

curl -sS http://127.0.0.1:7420/api/v1/sessions
# {"items":[]} after a clean clear
```

If `agents` is empty, the agent is not registered — fix WS URL / restart agent before creating sessions.

---

## 5. Happy path: create → assign → complete

### 5.1 Echo dry-run (required)

Proves queue, claim, checkout, log stream, terminal status **without** an AI CLI.

```bash
CREATE=$(curl -sS -X POST http://127.0.0.1:7420/api/v1/sessions \
  -H 'content-type: application/json' \
  -d '{
    "repositoryId": "demo",
    "prompt": "hello-from-e2e",
    "commandProfile": "echo-prompt",
    "timeout": 60,
    "ref": "main",
    "requiredLabels": ["echo"]
  }')
echo "$CREATE"
SID=$(printf '%s' "$CREATE" | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>console.log(JSON.parse(s).id))")

# Scheduler must be invoked: create alone does not auto-assign locally
curl -sS -X POST http://127.0.0.1:7420/api/v1/scheduler/assign
# expect items[].sessionId === $SID

# Poll until terminal (completed | failed | cancelled | timed_out)
for i in $(seq 1 30); do
  curl -sS "http://127.0.0.1:7420/api/v1/sessions/$SID"
  echo
  sleep 1
done
```

**Pass:**

| Check     | Expect                                                                                |
| --------- | ------------------------------------------------------------------------------------- |
| Create    | `201` body: `status: "queued"`, `url`, `ref: "main"`, `commandProfile: "echo-prompt"` |
| Assign    | one item for `$SID` / `wt-1` / your `agentId`                                         |
| Terminal  | `status: "completed"`, `exitCode: 0`                                                  |
| Logs      | `GET /api/v1/sessions/$SID/logs` has system lines (claim, checkout, spawn) + stdout   |
| Agent log | lines like `Claimed worktree`, `Checked out ref main`, `Spawning: echo …`             |

### 5.2 Real CLI (preferred pre-deploy) — Grok example

Only if `grok` (or another profile) is installed and listed in `command-profiles`.

```bash
CREATE=$(curl -sS -X POST http://127.0.0.1:7420/api/v1/sessions \
  -H 'content-type: application/json' \
  -d '{
    "repositoryId": "demo",
    "prompt": "List the files in the current directory in one short sentence. Do not edit or create any files.",
    "commandProfile": "grok-print",
    "timeout": 180,
    "ref": "main",
    "requiredLabels": ["grok"]
  }')
SID=$(printf '%s' "$CREATE" | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>console.log(JSON.parse(s).id))")
curl -sS -X POST http://127.0.0.1:7420/api/v1/scheduler/assign

# Poll up to a few minutes
for i in $(seq 1 90); do
  SESS=$(curl -sS "http://127.0.0.1:7420/api/v1/sessions/$SID")
  STATUS=$(printf '%s' "$SESS" | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>console.log(JSON.parse(s).status))")
  echo "t=$i status=$STATUS"
  case "$STATUS" in completed|failed|cancelled|timed_out) echo "$SESS"; break ;; esac
  sleep 2
done

curl -sS "http://127.0.0.1:7420/api/v1/sessions/$SID/logs"
```

**Pass:**

| Check      | Expect                                                                                           |
| ---------- | ------------------------------------------------------------------------------------------------ |
| Spawn line | Agent log shows full `grok … -p <prompt>` (or your CLI argv) — **not** a shell string            |
| Terminal   | `completed` with exit 0 for a simple read-only prompt (or documented non-zero if CLI fails auth) |
| Stdout     | Session logs include CLI output (e.g. mentions `README.md` / repo files)                         |
| Worktree   | `$WORK/worktrees/wt-1` is a git worktree on `main` (or the requested `ref`)                      |

**Fail hard if:**

- Assign returns a **different** `sessionId` than the one you just created → queue pollution; re-run §2 clear.
- Session stays `queued` forever → agent offline, wrong `requiredLabels`, or worktree busy/offline.
- Profile not in `GET /command-profiles` → agent did not register that name (config not loaded).

### 5.3 Negative: free-form / unknown profile

```bash
curl -sS -o /tmp/bad-profile.json -w "%{http_code}" -X POST http://127.0.0.1:7420/api/v1/sessions \
  -H 'content-type: application/json' \
  -d '{
    "repositoryId": "demo",
    "prompt": "x",
    "commandProfile": "rm -rf /",
    "timeout": 10
  }'
# create may succeed as queued; agent must not execute arbitrary shell.
# Prefer web UI path which rejects unknown profiles before create:
```

Web create path (D4):

```bash
# with API + web + registered agent running:
curl -sS -X POST http://127.0.0.1:3000/api/create-session \
  -H 'content-type: application/json' \
  -d '{
    "repositoryId": "demo",
    "prompt": "x",
    "commandProfile": "rm -rf /",
    "timeout": 1
  }'
# expect HTTP 400 — profile not in agent-reported list
```

---

## 6. Web manage UI smoke

With `pnpm local:web` and API up:

| URL                                | Check                                                          |
| ---------------------------------- | -------------------------------------------------------------- |
| http://127.0.0.1:3000/             | Create form; profile **dropdown** includes only agent profiles |
| http://127.0.0.1:3000/sessions     | Lists sessions; completed session visible                      |
| http://127.0.0.1:3000/agents       | Shows agent online + profiles                                  |
| http://127.0.0.1:3000/repositories | List/add works against API                                     |
| http://127.0.0.1:3000/schedules    | List/add/trigger works                                         |

Automated: `pnpm local:manage-verify`.

---

## 7. Pre-deploy checklist (sign-off)

Copy into the PR or agent final report:

```text
[ ] pnpm check green
[ ] pnpm local:e2e / local:cli-e2e / local:api-smoke / local:ws-e2e / local:cloud-e2e green
[ ] DynamoDB Local cleared; no stale queued sessions
[ ] API :7420 health ok; agent online with expected commandProfiles
[ ] Echo session: create → assign → completed; logs present
[ ] Real CLI session (if available): create → assign → completed; spawn argv matches profile
[ ] Unknown / free-form profile rejected on web create path (400)
[ ] Web UI lists sessions/agents; profile dropdown is not free text
[ ] No secrets in prompts or session JSON
```

**Do not deploy** if any required box is unchecked (real CLI may be marked N/A only if explicitly out of scope for that deploy).

---

## 8. Teardown

```bash
# Stop background PIDs if you saved them
kill "$(cat "$WORK/logs/agent.pid")" 2>/dev/null || true
kill "$(cat "$WORK/logs/web.pid")" 2>/dev/null || true
kill "$(cat "$WORK/logs/api.pid")" 2>/dev/null || true

# Or free ports
for p in 7420 3000; do
  for pid in $(lsof -tiTCP:$p -sTCP:LISTEN 2>/dev/null || true); do kill "$pid" || true; done
done

pnpm local:dynamodb:down   # optional — stops DynamoDB container
rm -rf "$WORK"             # optional — drop demo workspace
```

---

## 9. Troubleshooting

| Symptom                                  | Likely cause                                                 | Fix                                                                        |
| ---------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------- |
| Assign returns wrong / older `sessionId` | Stale queue in DynamoDB                                      | §2 `clearAll` on `AutoHarness` tables; restart API                         |
| Session stuck `queued`                   | Agent not registered; labels mismatch; worktree offline/busy | Check `GET /agents`, `requiredLabels` vs worktree `labels`, agent log      |
| `EADDRINUSE` :7420                       | Previous API still running                                   | Kill listener on port; restart                                             |
| Profile missing from dropdown            | Agent not connected or config missing profile                | Restart agent with correct `--config`                                      |
| Grok hangs / interactive TUI             | Missing headless flags                                       | Use `-p` / `--single` + `--always-approve` + non-interactive output format |
| Worktree checkout fails                  | Bad absolute paths; missing git                              | Fix config paths; ensure primary repo is a git root                        |
| Unit tests green, E2E fails              | Not the same as deploy path                                  | Always run §1 + §5 before deploy claims                                    |

---

## 10. What this does **not** prove

- Live AWS CDK deploy, API Gateway WebSocket, or production TLS/auth cookies ([setup.md](setup.md), [auth.md](auth.md)).
- Multi-agent production capacity, rate limits, or Slack product integration.
- Safety of a fully compromised agent host or unbounded prompt content (see [security.md](security.md)).

Those are separate gates after local E2E is green.

---

## Related

| Doc                                          | Role                                 |
| -------------------------------------------- | ------------------------------------ |
| [local-development.md](local-development.md) | Day-to-day local commands            |
| [cli.md](cli.md)                             | Agent CLI reference                  |
| [api.md](api.md)                             | REST shapes                          |
| [agent.md](agent.md)                         | Agent internals                      |
| [harness.md](harness.md)                     | Repo harness fire-and-forget pattern |
| [plan.md](plan.md)                           | Phase acceptance criteria            |
