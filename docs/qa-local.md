# Local E2E QA

A numbered script for QAing Auto Harness on a laptop: automated gates, the
local stack, the control-plane UI, the debug host pane, fleet setup (hosts,
repos, providers — admin-shaped even when local auth is off), real
structured `grok -p` / `claude -p` / `codex exec --json` (and a required `echo` dry run), a
schedule, a short break-it pass, then teardown. **No AWS.** Do not treat
Add host as an operator step.

This is the local counterpart to [qa-production.md](qa-production.md). The
technical pre-deploy checklist that agents run before any cloud claim is
still [host-daemon-e2e-testing.md](host-daemon-e2e-testing.md). Playwright
ports, `data-pw`, and `next start` vs `next dev` live in [e2e.md](e2e.md) —
do not duplicate them here.

Keep this file in sync when the local product changes.

---

## Read this first

- **Fail closed on automated gates.** If `pnpm check` or a shipped
  `pnpm local:*` script is red, stop and fix. Do not "QA around" it.
- **Clear DynamoDB Local** before a manual pass. Leftover queued sessions
  steal worktree assigns; the scheduler walks the whole queue.
- **Two UIs.** Control plane is `:7421`. Host pane is `:7422` and is
  **debug-only**. Everything an operator needs must work from `:7421`. If
  a step seems to require `:7422`, that is a product bug.
- **Subscription CLIs need an unsandboxed shell** and a real `$HOME`
  login. Same trap as production — see
  [qa-production.md](qa-production.md#2-subscription-clis-need-an-unsandboxed-shell).
- **Quote placeholders.** Never paste a bare `<...>`.
- During the UI phases: **do not read product docs**. Navigate from
  labels. Write down every guess.

Local auth is typically disabled (`HARNESS_AUTH_MODE` unset). You will not
see login, service accounts, or the bound-key 404 unless you turn auth
on. That 404 is a production-only check — do it in
[qa-production.md](qa-production.md), not here.

---

## Prerequisites

| Need                          | Check                                                                         |
| ----------------------------- | ----------------------------------------------------------------------------- |
| Node.js ≥ 22.18               | `node -v`                                                                     |
| pnpm                          | `pnpm -v` (see root `packageManager`)                                         |
| Docker                        | DynamoDB Local                                                                |
| Git ≥ 2.36                    | worktrees and checkout recovery                                               |
| `grok` and `claude` on `PATH` | `which grok claude`; logged in                                                |
| `codex` (optional)            | `which codex`; recipe is `codex exec --json` (not `-p` — that is `--profile`) |

```bash
cd /path/to/auto-harness
pnpm install
```

There is **no `tsc` build**. Runtime is Node type stripping (`node …/*.ts`).

Ports (do not collide with another worktree's `:742x` — see
[e2e.md#isolated-focused-control-runs](e2e.md#isolated-focused-control-runs)
if you are not alone on this machine):

| Service          | Port                    |
| ---------------- | ----------------------- |
| API (+ `/ws`)    | `http://127.0.0.1:7420` |
| Control-plane UI | `http://127.0.0.1:7421` |
| Host pane UI     | `http://127.0.0.1:7422` |
| DynamoDB Local   | `http://127.0.0.1:7423` |

Playwright uses `743x` and its own DynamoDB container. It never shares
these ports.

---

## Phase 1 — Automated gates

From repo root. These exercise **shipped** scripts — not re-implementations.

```bash
pnpm check                 # lint, fmt, tests+coverage, knip, depcruise, links, no-mistakes
pnpm local:dynamodb
pnpm local:dynamodb:ready
pnpm local:e2e             # SessionRunner + ref + unknown target + hooks
pnpm local:cli-e2e         # documented pnpm local:daemon run-session (ref: main)
pnpm local:api-smoke       # POST /sessions → 201
pnpm local:ws-e2e          # real WebSocket create→assign→run
pnpm local:cloud-e2e       # DaemonLoop loopback
pnpm local:manage-verify   # repos/schedules/cancel/drain + thin web routes
```

`pnpm test:integration` is already inside `pnpm check`. Pointer only —
Playwright: `pnpm test:e2e`. Real-CLI Playwright (not CI):
`HARNESS_REAL_CLI=1 pnpm test:e2e:real-cli`. Details: [e2e.md](e2e.md).

**Pass:** each command exits 0; JSON includes `"ok": true` and/or the
documented HTTP status (`201` for smoke).

If any gate fails, **stop**.

---

## Phase 2 — Clean local state + throwaway repo

```bash
lsof -iTCP:7420 -sTCP:LISTEN || true
lsof -iTCP:7421 -sTCP:LISTEN || true
lsof -iTCP:7422 -sTCP:LISTEN || true
lsof -iTCP:7423 -sTCP:LISTEN || true
```

Clear default tables so a stale queue cannot steal assigns:

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

Throwaway git repo. **Do not pre-create the worktree directory** — the
daemon creates it on first sync.

```bash
WORK="$PWD/.local-qa-e2e"
rm -rf "$WORK"
mkdir -p "$WORK/repo" "$WORK/logs"
cd "$WORK/repo"
git init -b main
git config user.email "qa@auto-harness.local"
git config user.name "Auto Harness QA"
echo '# qa' > README.md
git add . && git commit -m "init"
cd - >/dev/null
```

---

## Phase 3 — Bring up the stack

Prefer separate terminals (or `pnpm local:tmux`). DynamoDB stays in Docker.

```bash
# A — already up from Phase 1
pnpm local:dynamodb
pnpm local:dynamodb:ready

# B — API
pnpm local:api
# → http://127.0.0.1:7420

# C — control plane
HARNESS_API_HTTP=http://127.0.0.1:7420 pnpm local:web
# → http://127.0.0.1:7421

# C2 — host pane (debug)
export HARNESS_HOST_ID=local-qa-1
export HARNESS_API_URL=http://127.0.0.1:7420
pnpm local:host-pane
# → http://127.0.0.1:7422

# D — daemon (unsandboxed shell). Foreground `start` is the local path.
# Persist (`pnpm local:daemon install-service`) is linux/macos/windows
# production — Linux refuses this loopback URL. See
# [deploy-host-daemon.md](deploy-host-daemon.md).
export HARNESS_HOST_ID=local-qa-1
export HARNESS_API_URL=http://127.0.0.1:7420
pnpm local:daemon start
```

**Health:**

```bash
curl -sS http://127.0.0.1:7420/health          # {"ok":true}
curl -sS http://127.0.0.1:7420/api/v1/hosts    # empty until the daemon registers
```

`GET /api/v1/hosts` should include `hostId: local-qa-1`, `online: true`
after the daemon starts. Empty `items` → fix the WS URL or restart the
daemon before creating anything.

Sanity the CLIs in the same unsandboxed shell **before** relying on them:

```bash
claude -p --output-format json 'Reply with exactly: OK'
grok --always-approve --max-turns 3 --output-format json -p 'Reply with exactly: OK'
# optional: codex exec --json 'Reply with exactly: OK'   # not `codex -p`
```

---

## Phase 4 — Fleet setup (control plane only)

Open `http://127.0.0.1:7421`. Do not read `web.md`. Local auth is usually
off — there is no login, so this phase is not "log in as operator then
Add host." In production those writes are **admin**
([qa-production.md](qa-production.md) Phase 2). Note whether the empty
Settings page is confusing.

1. **Hosts** — add host slot `local-qa-1` if the daemon has not already
   created one. Open host detail. This is fleet setup, not an operator
   session step.
2. **Attach a repository** to that host: absolute path `$WORK/repo`. Add
   one worktree (give it a path under `$WORK/worktrees/wt-1` — let the
   daemon create the directory).
3. **Providers → Add provider** for `claude`, `grok`, and `codex` with
   the same argv as [qa-production.md](qa-production.md) Phase 2 (one
   token per line). The presets request provider JSON envelopes; Codex is `codex exec --json`, **not** `-p` (`-p` is
   `--profile`). Skip `codex` if the binary is missing.
4. Create a Provider Account under each; **attach them to the host**.
   Note whether the UI warns if you skip attach.
5. **Commands** — add a standalone (providerless) command named
   `echo-prompt`, argv `echo`, append-prompt on. This is the required
   dry run.

Confirm `GET /api/v1/session-targets` lists the configured providers plus
`echo-prompt`. A provider that is missing there is almost always "account
not attached."

Host pane (`:7422`): you should see the same inventory. You must not
_need_ it. Record whether attach/edit is possible there and whether the
chrome says this is debug-only.

---

## Phase 5 — Sessions

Create from **New session** (primary). Do not Add host from here — the
slot already exists. Force a sweep when you do not want to wait a minute:

```bash
curl -sS -X POST http://127.0.0.1:7420/api/v1/scheduler/assign
```

### 5.1 Echo (required)

Target the standalone `echo-prompt` command. Prompt: `hello-from-qa`.

**Pass:** `queued → running → completed`, exit 0, logs show spawn +
stdout, worktree is a real git worktree on `main`.

### 5.2 Prompt matrix (structured `grok`, `claude`, optional `codex exec --json`)

Same rows as [qa-production.md](qa-production.md) Phase 4. Run each
against `grok` and `claude` unless a row is CLI-specific. If Codex is
configured, also run row 1 as `codex exec --json` (not `-p`).

| #   | Prompt                                                                                            | Why                              |
| --- | ------------------------------------------------------------------------------------------------- | -------------------------------- |
| 1   | `Reply with exactly: QA_SESSION_OK`                                                               | Happy path                       |
| 2   | `List the files in the current directory in one short sentence. Do not edit or create any files.` | Read-only cwd                    |
| 3   | empty / whitespace-only                                                                           | Validation vs queued-then-failed |
| 4   | a multi-kilobyte prompt                                                                           | List truncation vs detail        |
| 5   | `"; rm -rf /` then `Reply with exactly: QA_NO_SHELL`                                              | Not a shell string               |
| 6   | same `concurrencyId` while active, then after terminal                                            | dedup then retry                 |

Watch the session detail live log, not just `curl`. Spawn line must be
the resolved argv.

### 5.3 Negative

```bash
curl -sS -o /tmp/bad-target.json -w "%{http_code}" -X POST http://127.0.0.1:7420/api/v1/sessions \
  -H 'content-type: application/json' \
  -d '{
    "repositoryId": "demo",
    "prompt": "x",
    "target": { "commandId": "does-not-exist" },
    "timeout": 10
  }'
# expect 400
```

---

## Phase 6 — Schedule

From **Schedules** on `:7421`:

1. Create a schedule against the throwaway repo and a provider (or the
   echo command). Set a concurrency id. Cron `0 * * * *` is fine.
2. **Run now**. Expect a session with source `schedule`, a history row,
   worktree labeled **Main checkout**.
3. Disable the schedule. Record whether **Run now** still works.
4. **Run now** twice with the same concurrency id while the first is
   active.

---

## Phase 7 — Exploratory / UX

Shorter than production (no CloudFront, no bound keys):

- `EADDRINUSE` on `:7420` — is the failure obvious?
- Skip `clearAll`, leave a queued session, create another — does assign
  go to the wrong id?
- Attach a path that is not a git repo.
- Unknown target already covered in 5.3.
- Narrow viewport + keyboard-only on new session and schedule create.
- Dashboard counts vs Sessions list vs host worktree busy/idle after the
  runs above.

UX score (no glossary):

- Can you tell Host / Session / Provider / Command / Worktree apart?
- Empty states: next click named?
- Missing provider-account attach: silent or warned?
- Host pane obviously debug-only?

---

## Phase 8 — Tear down

```bash
# Stop daemon, web, host pane, API (PIDs if you saved them, else ports)
for p in 7420 7421 7422; do
  for pid in $(lsof -tiTCP:$p -sTCP:LISTEN 2>/dev/null || true); do
    kill "$pid" 2>/dev/null || true
  done
done

pnpm local:dynamodb:down
rm -rf "$WORK"            # only after confirming this is the throwaway path
```

Clearing tables (`storage.clearAll`) deletes local control-plane state
only. It does not remove git worktrees on disk. Do not `rm -rf` a real
working tree.

---

## Pass/fail checklist

- [ ] `pnpm check` and every Phase 1 `pnpm local:*` script green
- [ ] DynamoDB Local cleared; ports free
- [ ] API `:7420` health ok; daemon `local-qa-1` online
- [ ] Repository + worktree attached from `:7421`; daemon created the
      worktree
- [ ] Fleet setup (hosts/repos/providers) done from `:7421` as admin-shaped
      writes — not an operator Add host step
- [ ] Providers `grok` and `claude` + accounts attached; standalone
      `echo-prompt` exists; `codex` (`codex exec`) if the binary is present
- [ ] Echo session completed; logs present
- [ ] At least one `claude -p` and one `grok -p` session completed with
      expected stdout
- [ ] If Codex was configured: at least one `codex exec` session completed
- [ ] Prompt matrix rows recorded
- [ ] Unknown `commandId` rejected 400
- [ ] Schedule **Run now** produced a `schedule` session and history row
- [ ] Host pane was unused for any required operator step
- [ ] UX notes captured
- [ ] Processes stopped; DynamoDB container down; throwaway `$WORK` gone

---

## After the run

Findings from this run (blockers, UX, doc drift, follow-up PRs):
[qa-production.md — After the run](qa-production.md#after-the-run).
Local-only traps stay in the section below. Update this file when a step
is wrong.

Troubleshooting table for local symptoms:
[host-daemon-e2e-testing.md](host-daemon-e2e-testing.md#9-troubleshooting).

---

## Traps found on 2026-08-18 (this run)

- Daemon log after connect: `add local repos in the host pane UI` —
  that contradicts invariant 10. Attach from the control plane
  (`:7421` host detail → Repositories & Worktrees).
- Dashboard "Get started" still says **Connect a host** when
  Hosts online is already `1/1`.
- **Logout** is visible with auth disabled.
- Settings says "Authentication disabled" / loopback and hides
  service-account management — expected, easy to misread.
- Host detail defaults to **Overview**; attach lives on
  **Repositories & Worktrees**.
- `PUT /hosts/:id/inventory` accepts a garbage `providerAccountId`
  and then `GET /session-targets` marks the provider `available:false`
  with no error.
- Documented grok argv (`-p` + `--` separator + `--output-format
plain`) fails on grok 1.0.5. Use
  `["grok","--always-approve","--max-turns","3","-p"]` with
  append-prompt on and the `--` separator **off**.
- Whitespace-only prompts are accepted; `echo` prints them.
- `"; rm -rf /` is not a shell — `echo` printed the string. Good.
- Default schedule prompt is `scheduled:<name>` (same as production).
- `pnpm check` typecheck failed in this worktree
  (`Could not find a declaration file for module 'react-dom/client'`
  despite `@types/react-dom` in `modules/ui`). Local-only; investigate
  before treating the gate as red for the product.

## What this does not prove

- Live AWS CDK deploy, API Gateway WebSocket, TLS, or production cookies
  — that is [qa-production.md](qa-production.md).
- Bound vs unbound service-account behavior (local auth is usually off).
- Slack / GitHub integrations.
- Cost numbers ([costs.md](costs.md)).
