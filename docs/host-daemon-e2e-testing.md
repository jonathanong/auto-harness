# Agent E2E testing (local, pre-deploy)

**Audience:** coding agents (and humans) validating Auto Harness **locally** before any cloud deploy.

**Bar:** the full control-plane + agent + (optional) web path works with **real** DynamoDB Local, **real** HTTP/WS, **real** git worktrees, and a **real non-interactive CLI** command (e.g. `grok`, `codex`, `claude`, or `echo` for a dry run). Do not claim “ready to deploy” after unit tests alone.

Related: [local-development.md](local-development.md) (runbook), [deploy-local.md](deploy-local.md) (local ops), [deploy.md](deploy.md) (ops index), [cli.md](cli.md) (agent CLI), [api.md](api.md) (REST), [websocket.md](websocket.md), [plan.md](plan.md) (acceptance criteria).

---

## 0. Preconditions

| Need            | Check                                                                   |
| --------------- | ----------------------------------------------------------------------- |
| Node.js ≥ 22.18 | `node -v`                                                               |
| pnpm            | `pnpm -v` (see root `packageManager`)                                   |
| Docker          | for DynamoDB Local                                                      |
| Git ≥ 2.20      | worktrees                                                               |
| Optional AI CLI | `which grok` / `which codex` / `which claude` / etc. for a real command |

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
pnpm test:integration      # real HTTP+WS + daemon + CLI, including durable scheduler/restart proof
pnpm local:e2e             # SessionRunner + ref + unknown target + hooks
pnpm local:cli-e2e         # documented pnpm local:daemon run-session (ref: main)
pnpm local:api-smoke       # POST /sessions → 201 queued
pnpm local:ws-e2e          # real WebSocket create→assign→run
pnpm local:cloud-e2e       # DaemonLoop loopback
pnpm local:manage-verify   # repos/schedules/cancel/drain + thin web routes
```

`pnpm test:integration` (config: `vitest.integration.config.ts`, tests under `integration/`) is its
own CI job, separate from the unit-test coverage gate. It keeps the fast `useDynamo: false`
orchestration check and also runs a durable proof against DynamoDB Local: repository, command, and
host inventory setup over HTTP; real daemon bootstrap and WebSocket registration; automatic local
scheduler dispatch; a real git worktree and subprocess; log/result reads; and an API restart that
re-reads the terminal session and logs from DynamoDB. The sections below remain the full manual and
real-vendor-CLI pass.

**Pass criteria (each):** exit 0; JSON includes `"ok": true` and/or documented HTTP status (`201` for smoke).

If any gate fails, **stop** and fix before manual stack testing.

---

## 2. Clean DynamoDB Local state

Leftover queued sessions from prior smokes will steal worktree assigns (scheduler walks the whole queue). Before a manual E2E, clear the default tables:

```bash
export HARNESS_DDB_ENDPOINT=http://127.0.0.1:7423
export AWS_ACCESS_KEY_ID=local
export AWS_SECRET_ACCESS_KEY=local
export AWS_REGION=us-east-1

node --input-type=module <<'EOF'
import { createControlPlane } from "./services/api/src/create-plane.ts";
const { storage } = await createControlPlane({
  tablePrefix: "AutoHarness",
  publicBaseUrl: "http://127.0.0.1:7421",
});
await storage.clearAll();
console.log(JSON.stringify({ ok: true, cleared: "AutoHarness" }));
EOF
```

Confirm nothing is listening on the ports you need (or stop prior processes):

```bash
lsof -iTCP:7420 -sTCP:LISTEN || true  # API
lsof -iTCP:7421 -sTCP:LISTEN || true  # web
lsof -iTCP:7422 -sTCP:LISTEN || true  # agent-web
lsof -iTCP:7423 -sTCP:LISTEN || true  # DynamoDB Local
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
CLAUDE_BIN="$(command -v claude || true)"
```

### Providers, Provider Accounts, and Commands (D4)

Sessions target a **Provider** (which selects a healthy attached account from its pool) or a **Command** (which selects that exact command; provider-owned commands use their provider's account pool). A Command with `providerId: null` is a providerless pure CLI and runs ungated on any worktree. Either way the resolved `argv` is always a **named, fixed array** — never a free-form shell string. There is no host-inventory `commandProfiles` map to author by hand anymore; catalog entries are created once via REST, then accounts are attached to the host.

| Catalog entry                                          | Purpose                                                      |
| ------------------------------------------------------ | ------------------------------------------------------------ |
| standalone `echo`                                      | Always available; proves assign/checkout/logs without AI     |
| `grok` / `codex` / `claude` Provider + default Command | Real non-interactive CLI (optional but preferred pre-deploy) |

Create the catalog entries against the running API (Terminal B in §4 must already be up — or run these right after starting it, before creating any session):

```bash
API=http://127.0.0.1:7420

# Standalone echo command — always create this one. Save its id for §5.
ECHO_CMD=$(curl -fsS -X POST "$API/api/v1/commands" -H 'content-type: application/json' \
  -d '{"name":"echo-prompt","argv":["echo"],"appendPrompt":true,"providerId":null}')
ECHO_COMMAND_ID=$(printf '%s' "$ECHO_CMD" | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>console.log(JSON.parse(s).id))")

# Optional real CLIs — each is a Provider + its default Command + one account.
# Flags below are empirically verified (see §5.2); omit whichever binary you don't have.
if [ -n "$GROK_BIN" ]; then
  PROV=$(curl -fsS -X POST "$API/api/v1/providers" -H 'content-type: application/json' -d '{"name":"grok"}')
  PID=$(printf '%s' "$PROV" | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>console.log(JSON.parse(s).id))")
  CMD=$(curl -fsS -X POST "$API/api/v1/commands" -H 'content-type: application/json' \
    -d "{\"name\":\"grok-print\",\"argv\":[\"$GROK_BIN\",\"--always-approve\",\"--max-turns\",\"3\",\"--output-format\",\"plain\",\"-p\"],\"appendPrompt\":true,\"providerId\":\"$PID\"}")
  CID=$(printf '%s' "$CMD" | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>console.log(JSON.parse(s).id))")
  curl -fsS -X PATCH "$API/api/v1/providers/$PID" -H 'content-type: application/json' -d "{\"defaultCommandId\":\"$CID\"}"
  ACCT=$(curl -fsS -X POST "$API/api/v1/provider-accounts" -H 'content-type: application/json' \
    -d "{\"providerId\":\"$PID\",\"label\":\"e2e\"}")
  GROK_ACCOUNT_ID=$(printf '%s' "$ACCT" | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>console.log(JSON.parse(s).id))")
fi
```

Same shape for `codex` (`argv: ["$CODEX_BIN", "exec"]`) and `claude` (`argv: ["$CLAUDE_BIN", "-p"]`) — see §5.2 for the exact commands.

Then attach the host's repositories/worktrees **and** any Provider Accounts you created (`providerAccounts` replaces the old `commandProfiles` map — it is a list of `{providerAccountId}` attachments, not fixed argv):

```bash
cat > "$WORK/config/host-inventory.config.json" <<EOF
{
  "commandProfiles": {},
  "providerAccounts": [
    $([ -n "$GROK_ACCOUNT_ID" ] && echo "{\"providerAccountId\": \"$GROK_ACCOUNT_ID\"}")
  ],
  "repositories": [
    {
      "id": "demo",
      "path": "$WORK/repo",
      "defaultBranch": "main",
      "worktrees": [
        {
          "id": "wt-1",
          "name": "wt-1",
          "path": "$WORK/worktrees/wt-1",
          "labels": ["echo", "grok"]
        }
      ]
    }
  ]
}
EOF
```

If a CLI is not installed, **skip** creating its Provider/Account and only run the echo command — still required for assign/WS proof. Document that a real CLI was skipped.

Agent process identity (env only):

```bash
export HARNESS_HOST_ID=local-e2e-1
export HARNESS_API_URL=http://127.0.0.1:7420
# optional: HARNESS_API_KEY, HARNESS_LOG_LEVEL
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

# Publish host inventory (once API is up)
curl -fsS -X PUT "http://127.0.0.1:7420/api/v1/hosts/local-e2e-1/inventory" \
  -H 'content-type: application/json' \
  -d @"$WORK/config/host-inventory.config.json"

# Terminal C — Control-plane UI (:7421)
HARNESS_API_HTTP=http://127.0.0.1:7420 pnpm local:web

# Terminal C2 — Host pane UI (:7422) — host inventory for this agent
export HARNESS_HOST_ID=local-e2e-1
export HARNESS_API_URL=http://127.0.0.1:7420
pnpm local:host-pane
# open http://127.0.0.1:7422/repositories  (or PUT config via curl as below)

# Terminal D — Agent daemon (env identity only)
export HARNESS_HOST_ID=local-e2e-1
export HARNESS_API_URL=http://127.0.0.1:7420
pnpm local:daemon start
# → connected … / agent … registered

# Validate bootstrap
pnpm local:daemon status
# expect hostId, repositories, providerAccounts from the control plane
```

**Health checks:**

```bash
curl -sS http://127.0.0.1:7420/health
# {"ok":true}

curl -sS http://127.0.0.1:7420/api/v1/hosts
# items include hostId, online:true, worktreeIds

curl -sS http://127.0.0.1:7420/api/v1/session-targets
# items list the unified picker source: attached provider accounts + standalone commands
# (e.g. Provider "grok", Command "echo-prompt") — this is what the web create-session/schedule forms fetch

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
  -d "{
    \"repositoryId\": \"demo\",
    \"prompt\": \"hello-from-e2e\",
    \"target\": { \"commandId\": \"$ECHO_COMMAND_ID\" },
    \"queueTtlSeconds\": 691200,
    \"timeout\": 60,
    \"ref\": \"main\",
    \"requiredLabels\": [\"echo\"]
  }")
echo "$CREATE"
SID=$(printf '%s' "$CREATE" | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>console.log(JSON.parse(s).id))")

# The local scheduler dispatches automatically (a sweep runs when the API
# starts, then once per minute). Force a sweep instead of waiting when running this smoke:
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

| Check     | Expect                                                                                                                        |
| --------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Create    | `201` body: `status: "queued"`, `url`, `ref: "main"`, `target: { commandId }`, `queueExpiresAt`, `targetLabel: "echo-prompt"` |
| Assign    | one item for `$SID` / `wt-1` / your `hostId`                                                                                  |
| Terminal  | `status: "completed"`, `exitCode: 0`                                                                                          |
| Logs      | `GET /api/v1/sessions/$SID/logs` has system lines (claim, checkout, spawn) + stdout                                           |
| Agent log | lines like `Claimed worktree`, `Checked out ref main`, `Spawning: echo …`                                                     |

### 5.2 Real CLI (preferred pre-deploy) — Grok example

Only if `grok` (or another provider) is installed and its Provider Account was created in §3. Targets the Provider (`providerId`), not an account — scheduling selects a healthy attached account from that provider's pool and resolves the provider-default Command (`grok-print`) at assign time.

```bash
CREATE=$(curl -sS -X POST http://127.0.0.1:7420/api/v1/sessions \
  -H 'content-type: application/json' \
  -d "{
    \"repositoryId\": \"demo\",
    \"prompt\": \"List the files in the current directory in one short sentence. Do not edit or create any files.\",
    \"target\": { \"providerId\": \"$PID\" },
    \"fallbacks\": [{ \"commandId\": \"$ECHO_COMMAND_ID\" }],
    \"queueTtlSeconds\": 691200,
    \"timeout\": 180,
    \"ref\": \"main\",
    \"requiredLabels\": [\"grok\"]
  }")
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
| Spawn line | Agent log shows full `grok … -p <prompt>` (the resolved Command's argv) — **not** a shell string |
| Terminal   | `completed` with exit 0 for a simple read-only prompt (or documented non-zero if CLI fails auth) |
| Stdout     | Session logs include CLI output (e.g. mentions `README.md` / repo files)                         |
| Worktree   | `$WORK/worktrees/wt-1` is a git worktree on `main` (or the requested `ref`)                      |

For a duplicate-create check, submit the same payload with an exact `concurrencyId` twice while
the first session is queued/running. The first response must be `201` with `created: true`; the
second must be `200` with `created: false` and the same `id`. After a terminal status, the identity
may be submitted again as an explicit retry.

**Fail hard if:**

- Assign returns a **different** `sessionId` than the one you just created → queue pollution; re-run §2 clear.
- Session stays `queued` forever → agent offline, wrong `requiredLabels`, worktree busy/offline, or the Provider Account isn't attached to that host (`resolveSessionTargetArgv` returns `null` for that worktree — see `provider-cascade.ts`).
- Account not in `GET /session-targets` → not attached to any host, or its provider has no default command.

#### Claude and Codex — empirically confirmed flags

Verified live (throwaway git repo, prompt `"Reply with exactly: hello world. Do not use any tools."`):

- **`claude -p "<prompt>"`** — exit 0, printed exactly `hello world`. No directory-trust prompt, no extra flags needed. Command: `argv: ["claude", "-p"], appendPrompt: true`.
- **`codex exec "<prompt>"`** — exit 0, printed `hello world` plus codex's own session banner/token-count lines on stdout — assert a case-insensitive **substring** match (`/hello world/i`), not an exact line match. No sandbox/approval flag needed: default `approval: on-request` never triggers for a reply-only prompt that needs no tool calls, and stdin doesn't hang it (codex reads to EOF and proceeds once stdin is closed/empty, same as `spawn`'s default `"ignore"` stdio). Command: `argv: ["codex", "exec"], appendPrompt: true`. (`-p` on codex means `--profile`, unrelated to the prompt.)

Create their Providers/Commands the same way as Grok in §3 (`argv: ["$CLAUDE_BIN", "-p"]` / `argv: ["$CODEX_BIN", "exec"]`), attach an account to the host, then repeat the §5.2 flow with that account's id and prompt `"Reply with exactly: hello world. Do not use any tools. Do not read, create, or modify any files."`. Assert stdout matches `/hello world/i`.

### 5.3 Negative: unknown Provider / Command

Unlike the old free-form-shell risk, the API now only accepts a `{ providerId }` or `{ commandId }` target referencing an **existing catalog entry** — there's no string to inject. What's worth proving instead is that create-time validation actually rejects a bogus id, rather than silently queuing something that can never resolve:

```bash
curl -sS -o /tmp/bad-target.json -w "%{http_code}" -X POST http://127.0.0.1:7420/api/v1/sessions \
  -H 'content-type: application/json' \
  -d '{
    "repositoryId": "demo",
    "prompt": "x",
    "target": { "commandId": "does-not-exist" },
    "timeout": 10
  }'
cat /tmp/bad-target.json
# expect 400 — commandId not found (target validation rejects at create time, D4)
```

Also confirm malformed target objects, unknown fallback ids, and duplicate target/fallback references are rejected 400.

---

## 6. Web manage UI smoke

With `pnpm local:web` and API up:

| URL                                | Check                                                                                                                          |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| http://127.0.0.1:7421/             | Create form; target **dropdown** (`GET /session-targets`) lists Providers + Commands, including providerless pure CLI commands |
| http://127.0.0.1:7421/sessions     | Lists sessions; completed session visible                                                                                      |
| http://127.0.0.1:7421/hosts        | Shows host online + its Provider accounts tab                                                                                  |
| http://127.0.0.1:7421/repositories | List/add works against API                                                                                                     |
| http://127.0.0.1:7421/schedules    | List/add/trigger works                                                                                                         |
| http://127.0.0.1:7421/providers    | List/add works; add-provider creates its default command too                                                                   |
| http://127.0.0.1:7421/commands     | List/add/edit/delete works                                                                                                     |

Automated: `pnpm local:manage-verify`.

---

## 7. Pre-deploy checklist (sign-off)

Copy into the PR or agent final report:

```text
[ ] pnpm check green
[ ] pnpm local:e2e / local:cli-e2e / local:api-smoke / local:ws-e2e / local:cloud-e2e green
[ ] DynamoDB Local cleared; no stale queued sessions
[ ] API :7420 health ok; agent online; expected Provider Accounts attached
[ ] Echo session: create → assign → completed; logs present
[ ] Real CLI session (if available): create → assign → completed; spawn argv matches the resolved Command
[ ] Unknown target/fallback providerId/commandId rejected at session create (400)
[ ] Account usage limit pauses that account globally; fallback assignment or queue wait works; queued expiry reports `queue_expired`
[ ] Native resume uses the source route when available, otherwise becomes a fresh target/fallback run
[ ] Web UI lists sessions/hosts; target dropdown is not free text
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
for p in 7420 7421; do
  for pid in $(lsof -tiTCP:$p -sTCP:LISTEN 2>/dev/null || true); do kill "$pid" || true; done
done

pnpm local:dynamodb:down   # optional — stops DynamoDB container
rm -rf "$WORK"             # optional — drop demo workspace
```

---

## 9. Troubleshooting

| Symptom                                  | Likely cause                                                 | Fix                                                                                                 |
| ---------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| Assign returns wrong / older `sessionId` | Stale queue in DynamoDB                                      | §2 `clearAll` on `AutoHarness` tables; restart API                                                  |
| Session stuck `queued`                   | Agent not registered; labels mismatch; worktree offline/busy | Check `GET /agents`, `requiredLabels` vs worktree `labels`, agent log                               |
| `EADDRINUSE` :7420                       | Previous API still running                                   | Kill listener on port; restart                                                                      |
| Target missing from dropdown             | Provider account not attached to any host, or agent offline  | Attach it on the host detail page's Provider accounts tab, or `POST /commands` for a standalone one |
| Grok hangs / interactive TUI             | Missing headless flags                                       | Use `-p` / `--single` + `--always-approve` + non-interactive output format                          |
| Worktree checkout fails                  | Bad absolute paths; missing git                              | Fix config paths; ensure primary repo is a git root                                                 |
| Unit tests green, E2E fails              | Not the same as deploy path                                  | Always run §1 + §5 before deploy claims                                                             |

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
| [host-daemon.md](host-daemon.md)             | Agent internals                      |
| [harness.md](harness.md)                     | Repo harness fire-and-forget pattern |
| [plan.md](plan.md)                           | Phase acceptance criteria            |
