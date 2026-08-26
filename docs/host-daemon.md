# Agent Layer (VPS Execution Plane)

Internals of the VPS daemon: process model, worktrees, executor, recovery.

## Session usage and cost attribution

Usage accounting is separate from usage-limit detection. A provider-aware CLI adapter may return a
structured `SessionUsage` value from the process runner; the daemon forwards it in terminal status
or a `session:usage` frame. The daemon does not scan prompts, stdout, stderr, or retained logs for
token counts or prices, and the control plane accepts only `source: "cli"`. Counts and configured
monetary values are decimal strings; monetary values use integer micros. Provider rates are
optional operator configuration and are never fetched from a vendor.

| Need                       | Doc                                          |
| -------------------------- | -------------------------------------------- |
| Install / config / systemd | [setup.md](setup.md)                         |
| Local stack / e2e          | [local-development.md](local-development.md) |
| CLI commands               | [cli.md](cli.md)                             |
| Wire protocol              | [websocket.md](websocket.md)                 |
| Control plane              | [aws.md](aws.md)                             |

---

## Responsibilities

The agent owns:

| Concern                   | Implementation                                                       |
| ------------------------- | -------------------------------------------------------------------- |
| Outbound control channel  | Persistent WebSocket client to the control plane                     |
| Workspace concurrency     | Pre-provisioned git worktrees (one session per worktree)             |
| Process execution         | `node-pty` for assigned AI CLIs; `child_process` for git/setup/hooks |
| Main-checkout maintenance | Serial lock per repository for `scheduled` sessions                  |
| Live output               | Buffered stdout/stderr/system log streaming                          |
| Local secrets             | AI vendor keys, git credentials, `.env` files (never sent to AWS)    |
| Inventory reporting       | Worktree list + status on register and on change                     |

The agent **does not** implement the global queue, multi-agent round-robin, or durable session storage. Those live in the [AWS layer](aws.md).

---

## Runtime Overview

```mermaid
graph TB
    subgraph VPS
        subgraph "auto-harness-agent"
            CLI["CLI entry<br/>start / status / validate"]
            Cfg["Config Loader"]
            Conn["Connection Manager"]
            WTM["Worktree Manager"]
            Locks["Main Checkout Locks"]
            Runner["Session Runner"]
            Exec["Executor"]
            Log["Log Streamer"]
        end

        subgraph Disk
            Main["repo main checkout"]
            WT1["worktree wt-1"]
            WT2["worktree wt-2"]
            Env[".env / secrets"]
        end

        CLI --> Cfg
        Cfg --> Conn
        Cfg --> WTM
        Conn <--> Runner
        Runner --> WTM
        Runner --> Locks
        Runner --> Exec
        Exec --> Log
        Log --> Conn
        WTM --> WT1
        WTM --> WT2
        Locks --> Main
        Exec --> Env
    end

    Conn <-->|"WSS session:assign / log / status"| AWS["AWS control plane"]
```

### Package layout

```
services/host-daemon/
├── src/
│   ├── index.ts              # CLI entry (start, status, …)
│   ├── config.ts             # load + validate config / env
│   ├── connection.ts         # WebSocket client, reconnect, routing
│   ├── worktree-manager.ts   # create, claim, release, status
│   ├── session-runner.ts     # session orchestration
│   ├── executor.ts           # spawn + PTY + timeout + signals
│   ├── log-streamer.ts       # buffer, rate-limit, emit
│   ├── main-lock.ts          # per-repo main checkout mutex
│   └── types.ts              # agent-local types
└── package.json
```

---

## Startup Sequence

```mermaid
sequenceDiagram
    participant Main as agent start
    participant Cfg as Config
    participant WTM as Worktree Manager
    participant Conn as Connection
    participant AWS as Control plane

    Main->>Cfg: Load + validate JSON/env
    Main->>WTM: Ensure repos exist - create missing worktrees
    WTM->>WTM: git worktree add if needed - prune stale
    Main->>Conn: Connect wss://...?token=
    Conn->>AWS: $connect
    Conn->>AWS: host:register { hostId, worktrees[], capabilities{features,maxConcurrentAssignments}, providerAccountReadiness[], protocolVersion, runningAttempts[] }
    AWS-->>Conn: host:registered / session:assign (optional)
    Note over Main: Event loop: messages, sessions, heartbeats
```

On validation failure (missing repo path, bad JSON, missing key), the process exits non-zero before connecting.

---

## Internal Components

### Connection Manager

- Opens WebSocket with `Authorization: Bearer <apiKey>` (the key is kept out of URL/query logs)
- Sends `host:register` immediately after open, including `protocolVersion` and
  attempt-fenced `runningAttempts` (plus `runningSessions` for older control planes)
- Routes inbound messages by protocol command (`session:assign`, `session:cancel`,
  `session:acknowledged`, drain). In-flight state is keyed by `{sessionId, attemptId}`,
  not session id alone, so a delayed cancel/ACK/log from an old attempt cannot touch
  a newer assignment
- Auto-reconnect with exponential backoff: 1s → 2s → 4s → … → **max 60s**
- On reconnect: re-register full inventory + any **in-progress** attempts still running locally
- Responds to server `ping` with `pong`
- Handles `post` failures only as disconnect (server detects stale connections separately)

Outbound message types: `host:register`, `session:ack`, `session:log`, `session:status`, `worktree:status`, `pong`.

Each daemon process reports one opaque UUID and process start time on every registration. The UUID
remains unchanged across socket reconnects and inventory refreshes. A control plane with a prior
modern UUID records a restart only when a later registration reports a different UUID; first
registration is a baseline, and legacy registrations without the pair remain accepted. Detection
is durable local observability only: it neither restarts the host nor sends an external notification.

### Config Loader

- Merge file + env
- Resolve absolute paths
- Validate unique worktree ids, non-overlapping paths, non-empty `hostId`
- Expose immutable config snapshot to other modules
- Load daemon-local execution profiles from `HARNESS_EXECUTION_PROFILES` (JSON). Each profile is
  keyed by Provider Account ID and owns that account's CLI home and extra environment. Extra env
  may not set `HOME` or `USERPROFILE`; the isolated profile home always wins. `install-service`
  persists `HARNESS_EXECUTION_PROFILES` and `HARNESS_MAX_CONCURRENT_ASSIGNMENTS` in the service
  environment file. The profile JSON path must be absolute for `install-service`; relative paths
  are rejected rather than being interpreted using a supervisor working directory. Registration
  advertises only `ready` plus an opaque SHA-256 fingerprint of
  the home path and extra-env key names (values omitted) — never credentials, home paths, or env
  values. Assignment of a provider-backed session is refused (no ACK) when the exact account
  profile is missing or its home is not a directory. Unknown top-level or per-profile JSON keys
  are rejected so misspelled configuration cannot silently disable a profile.

```json
{
  "maxConcurrentAssignments": 4,
  "accounts": {
    "acct-claude-work": { "home": "/var/lib/harness/homes/claude-work" },
    "acct-codex-personal": {
      "home": "/var/lib/harness/homes/codex-personal",
      "env": { "CODEX_HOME": "/var/lib/harness/homes/codex-personal" }
    }
  }
}
```

### Worktree Manager

| Operation       | Behavior                                                                               |
| --------------- | -------------------------------------------------------------------------------------- |
| `ensureAll()`   | On startup: `git worktree list`; create missing via `git worktree add <path> <branch>` |
| `claim(id)`     | Local mutex: fail if already busy; set busy + `currentSessionId`                       |
| `release(id)`   | Clear session; set idle; emit `worktree:status`                                        |
| `snapshot()`    | Array for `host:register` and status CLI                                               |
| `markError(id)` | On unexpected git failures; report status `error`                                      |

**Concurrency:** number of configured worktrees. Each worktree runs **at most one** session at a time.

Worktree records in DynamoDB are written by the control plane from register/status messages; the agent is source of truth for **local** busy/idle.

### Session Runner

Orchestrates a single session after `session:assign`:

1. Validate payload (`sessionId`, `repositoryId`, `resolvedArgv`, `timeout`, optional `worktreeId`, `prompt`, `setupScript`, `resume`, `resumedFromSessionId`, `cliResumeRef`, and non-secret route metadata)
2. If `worktreeId` set → claim worktree; else → acquire main-checkout lock for `repositoryId`
3. Send `session:ack`
4. **Setup:**
   - Normal run: run the optional host setup, then the effective assignment/worktree/repository
     setup (may initialize the shell environment, reset a branch, or install dependencies)
   - **Resume** (`resume: true`): skip every host/repository/worktree setup script; the assigned worktree still checks out the session `ref` (or default branch) before the native CLI resume command starts
5. Spawn primary command via Executor (resume-aware argv when `resume: true`)
6. Pipe output to Log Streamer
7. On exit / timeout / cancel → `session:status`, release claim/lock, emit worktree status
8. If the CLI prints a resumable conversation/session id, capture and send it in status metadata as `cliResumeRef` for later resumes

Concurrent sessions: one runner instance per claimed worktree (and at most one main-lock session per repo).

Git checkout/setup failures retain a stable operation category (for example, switch, fetch,
resolve, or verification) and may include a short diagnostic excerpt. Git diagnostics are
single-line and UTF-8 bounded before they are placed in exceptions, logs, or `session:status`;
remote URL userinfo and token-shaped credential values are redacted.

### Session resume

Operators resume by session id via the control plane: [`POST /sessions/:id/resume`](api.md#post-sessionsidresume). The control plane first prefers the source session's native route. If that route is no longer schedulable, it discards the stored `cliResumeRef` and placement pins, preserves `resumedFromSessionId`, and schedules a fresh run through the configured target and ordered fallbacks. The agent then tries native resume only when the assignment includes a usable route.

```mermaid
sequenceDiagram
    participant User
    participant API as Control plane
    participant Agent
    participant CLI

    User->>API: POST /sessions/{id}/resume
    API->>API: New session pinned to source agent
    API->>Agent: session:assign { resume: true, worktreeId, … }
    Agent->>Agent: Claim eligible worktree and check out ref
    Agent->>CLI: Resume / continue (tool-specific)
    CLI-->>Agent: output
    Agent->>API: session:log / session:status
```

#### Placement (control plane)

| Rule             | Behavior                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------- |
| Prefer           | Pin the source `hostId`; select any eligible repository worktree there for `cliResumeRef`         |
| Re-establish ref | Check out the source session's `ref`, or its default branch, before starting the native CLI route |
| Re-route         | If unavailable, clear `cliResumeRef` and the host pin, then use target/fallback order             |
| Preserve         | Keep `resumedFromSessionId` on the fresh assignment for audit/history                             |
| Same agent state | Native resume uses CLI conversation state stored outside the repository worktree                  |

#### How the agent “tries to resume”

Order of preference:

1. **Native CLI resume** — after the assigned worktree checks out `ref` (or the default branch), invoke the tool's resume/continue mode with `cliResumeRef` and the continuation prompt.
2. **Fresh route** — if the native route cannot be scheduled, the control plane discards the native ref/host pin and executes the normal target/fallback chain. This is a fresh CLI run, but retains `resumedFromSessionId`.

#### Must / must not

| Must                                                                                             | Must not                                                                                                 |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Use the scheduler-assigned eligible worktree and re-check out the stored `ref` or default branch | Pin native resume to the source worktree or depend on its dirty/uncommitted state                        |
| Skip every configured setup script on native resume                                              | Run setup scripts that may reset, install, or otherwise mutate the re-established checkout               |
| Stream logs and honor timeout/cancel as usual                                                    | Assume every CLI has native resume — a fresh fallback route is valid when native resume is unschedulable |

#### Capturing `cliResumeRef`

When a CLI emits a session/conversation id, parse and return it on terminal `session:status` (or a dedicated field). The control plane stores it on the session row and passes it back in `session:assign` only for a native-route resume. A provider/account/route id is diagnostic metadata; it never changes the daemon's command resolution.

### Executor

**Goals:** correct TTY behavior for AI CLIs; no shell injection of prompts; **non-interactive** invocation suitable for **subscription-plan** CLIs (not Agent SDKs)—see [why.md](why.md) and [costs.md](costs.md).

#### Command execution model

| Piece             | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spawn             | Prefer **argv array** / `node-pty` spawn **without** `shell: true`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `resolvedArgv`    | From `session:assign` — already resolved control-plane-side from the selected target/fallback (**non-interactive CLI** form, e.g. `codex exec` / print flags, `claude -p`, not an Agent SDK process). The agent does zero provider/account/command resolution — an empty `resolvedArgv` is a defensive error (`unknown_command_profile`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Route metadata    | Optional non-secret `targetIndex`, `commandId`, and `providerAccountId` breadcrumbs for logs and UI diagnostics. They are never used to select a command. A `providerAccountId` **does** select the daemon-local execution profile (CLI `HOME` / extra env) for the assigned AI CLI. Git, setup scripts, and terminal hooks keep the daemon's own child environment.                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `prompt`          | Already appended as the final `resolvedArgv` element when the Command's `appendPrompt` is true — **never** interpolated into a shell string. A literal `--` is inserted first when the Command opts in via `appendPromptSeparator`, or implicitly whenever the Command has a `providerId` and does not opt out (`appendPromptSeparator: false`) — safe only for getopt-style executables; e.g. `printf "%s"` reads `--` as data, not a terminator. See [api.md](api.md#post-commands).                                                                                                                                                                                                                                                                                                                                           |
| Working directory | Worktree path, or main repo path for scheduled sessions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Environment       | Small baseline (`PATH`, home/temp/locale/terminal fields) plus explicit `HARNESS_CHILD_ENV_ALLOWLIST`; control-plane `HARNESS_*` credentials are never inherited. Repo-local env files may be sourced only inside trusted setup scripts. **This includes CLI credential env vars** — `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and similar are silently dropped unless explicitly added to `HARNESS_CHILD_ENV_ALLOWLIST`. A CLI configured for API-key auth (rather than a logged-in subscription CLI, which reads its own credential file under `$HOME`) will fail with what looks like a CLI-side auth error, not an obviously harness-side config problem — check the allowlist first. Per-account execution profiles override `HOME`/`USERPROFILE` for the assigned CLI only so two accounts can use different local CLI homes. |
| Timeout           | A single deadline covers checkout checks, setup, and the primary command. Running processes receive SIGTERM, then SIGKILL after a 5-second grace period; report `timed_out`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Cancel            | `session:cancel { sessionId, attemptId }` aborts only that attempt through the same SIGTERM → 5s → SIGKILL chain; delayed cancels for an old attempt are ignored. Report exactly one `cancelled` terminal status.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

A repository-principal session drain uses this same cancel path. The control plane fences the
exact assignment attempt before sending `session:cancel`; the daemon reports its normal terminal
status and releases the worktree or main-checkout lock. A late acknowledgement, reconnect, or
terminal report is accepted only for that fenced attempt and cannot revive it or disturb a newer
assignment. The daemon does not list sessions or decide drain scope.

The assigned command runs in a single `node-pty` terminal (`xterm-256color`,
120 columns by 40 rows). Its merged terminal stream is reported as `stdout`,
including ANSI control sequences exactly as the CLI emits them. Resume-reference
capture treats configured stdout/stderr policies as matching this merged stream,
so opaque references remain captured and redacted. Git operations, trusted setup
scripts, and terminal hooks retain separate pipe-based execution;
this keeps PTY behavior confined to the CLI that needs a terminal. On POSIX,
cancel and timeout signal the PTY process group so helper descendants receive
the same SIGTERM → SIGKILL lifecycle.

Example (illustrative):

```text
assign.resolvedArgv = ["codex", "exec", "Fix the failing test"]  // computed control-plane-side

→ argv: ["codex", "exec", "Fix the failing test"]  // spawned as-is, no further resolution
→ cwd:  /home/harness/repos/my-app/.worktrees/wt-1
→ pty:  yes (cols/rows default 120x40)
```

If a site needs a full shell pipeline for maintenance, use a **scheduled** session whose `command` is a fixed script path on disk (e.g. `/home/harness/scripts/daily-update.sh`) rather than untrusted prompt text.

#### Signals and exit

| Event                    | Action                                                                                    |
| ------------------------ | ----------------------------------------------------------------------------------------- |
| Process exit 0           | `status: completed`, `exitCode: 0`                                                        |
| Process exit ≠ 0         | `status: failed`, `exitCode`                                                              |
| **Usage limit detected** | failed provider CLI + classifier → `status: failed`, `errorCode: usage_limit` (see below) |
| Timeout                  | kill → `status: timed_out`                                                                |
| Cancel                   | kill → `status: cancelled`                                                                |
| Setup non-zero           | no primary spawn → `status: failed`                                                       |

#### Usage limits (AI vendor / CLI quotas)

AI CLIs often hit **plan or rate limits** (monthly quota, TPM/RPM, “you've hit your limit”, etc.).
Auto Harness reports a limit only when its provider-aware adapter validates a structured CLI result;
ordinary stdout/stderr is never quota evidence. A reported limit lets the control plane pause the
assigned account, try another eligible account/fallback, or queue-wait for cooldown recovery.

**Policy: trusted identity + failure → classify → report → let the control plane route.**

1. The assigned command runs to completion. Timeout and cancel are never `usage_limit`.
2. Exit `0` is always `completed`. Successful output — including adversarial or prompt-controlled phrases such as “rate limit” — never cools down a Provider Account.
3. On a failed command (`exitCode !== 0`), the daemon requires **trusted assignment identity**
   (`providerAccountId` from the control plane), a recognized **trusted catalog argv** executable
   (`resolvedArgv[0]`, already resolved control-plane-side), and the provider-aware adapter's
   structured `usageLimit` signal. Untrusted stdout/stderr is never enough on its own.
4. On that signal, report `session:status` with `status: failed`, `errorCode: "usage_limit"`,
   `errorMessage: "Usage limit detected"`, and `exitCode`. Do not retry or resolve a fallback on
   the host.
5. The control plane then pauses the assigned Provider Account globally for its configured cooldown (default 5 hours), releases the worktree, and immediately tries the next eligible account or explicit fallback. A queued session remains eligible until its absolute `queueTtlSeconds` expires (default 8 days), then fails with `queue_expired`.

Providerless commands (`providerId: null`, no `providerAccountId`), unknown executables, and
provider commands without a supported structured result **fail closed**: their quota-like text is
an ordinary `failed`, not `usage_limit`. No account is paused.

**What counts as a usage-limit error:**

Classification keys off a provider-backed assignment (`providerAccountId`), the spawned catalog
executable (basename of `resolvedArgv[0]`), and an adapter-supported structured output mode. The
currently supported adapter set is `claude`, `codex`, `gemini`, and `grok`; it validates each
provider's terminal/error envelope before emitting `usageLimit`. A generic phrase such as `rate
limit`, `too many requests`, or a bare `429` is **never** enough, even with a trusted executable
and a non-zero exit. The adapter signal is also ignored on success, on unknown/providerless argv,
and when the assignment has no `providerAccountId`.

**What is not a usage limit:**

- Successful commands (`exitCode === 0`), even when output contains vendor phrases
- Prompt-controlled / adversarial stdout or stderr: free-form text cannot classify a limit
- Providerless commands (no `providerAccountId`), unknown executables, and non-structured provider commands (fail closed)
- App under test returning 429
- GitHub API secondary rate limits during a push (unless classified separately later)
- Agent host OOM / missing CLI → ordinary `failed` without `usage_limit`
- Auto Harness API rate limits (control plane `429`) — separate; see [api.md](api.md) / [security.md](security.md#rate-limiting)

Account cooldown is not a general retry policy: ordinary command failures, timeouts, and cancellations remain terminal. Only `usage_limit` invokes account cooldown/fallback routing. Cooldown duration is configurable per Provider Account, and operators can clear it manually.

### Log Streamer

- Attach to PTY data / stdout / stderr
- Tag `stream`: `stdout` | `stderr` | `system`
- Add ISO timestamps
- **Rate limit:** default max ~10 WebSocket messages/sec/session
- **Batch:** coalesce consecutive stdout/stderr lines up to `logBatchMaxLines` (100) or
  `logBatchMaxWaitMs` (100ms), and up to the per-frame byte budget. A single write is
  split on UTF-8 and newline bounds so each frame stays within those caps. A stream
  change parks the other stream behind the current batch (it is not dropped). A
  system/lifecycle line flushes queued batches first. Coalesced `session:log` frames
  still carry `{sessionId, attemptId}` and keep insertion order (`timestampSeq`)
- Emit `session:log` via Connection Manager. Per-session output is capped (32 KiB per chunk, 256 KiB retained for output classification, and at most 10,000 streamed chunks / 10 MiB retained logs), and sequence numbers continue after a reassignment/retry.
- Serialize outbound messages FIFO. The daemon flushes queued logs before it sends a terminal `session:status`; a failed send is reported but does not permanently block later messages.
- On backpressure: prefer coalescing. A stream change or next frame that cannot join
  the current batch parks one overflow batch instead of dropping. Stdout/stderr is
  dropped only when the current frame cannot flush **and** the overflow batch cannot
  accept the write; the daemon then emits a system warning `N log chunk(s) dropped`
  with machine-readable `dropped: N` telemetry the control plane can later alarm on.
  Session-wide chunk/byte caps remain silent (no `dropped` counter); they bound
  retained stdout/stderr, not the live rate. System and lifecycle lines still stream
  after those caps so failure/completion messages are not lost. Each `dropped` notice
  is capped at 1_000_000; remainder is sent on later notices.

Control plane persists logs and fans out to UI subscribers ([aws.md](aws.md)).

### Main Checkout Locks

For `type: scheduled` / `worktreeId: null`:

- One FIFO async mutex **per `repositoryId`** on this agent; different repositories remain parallel.
- Waiting consumes the session deadline. Cancellation or timeout removes the waiter without running setup, the command, or a terminal hook in the busy checkout.
- The lock covers branch preparation, setup, the command, and the terminal hook, and is released in `finally` on every outcome.
- The capability-gated dispatcher issues these assignments only to a live host
  that advertises `scheduled-main-checkout` and registers the repository. Its
  durable per-host/repository lease complements this local mutex.

---

## Worktrees

### Lifecycle

1. Operator configures worktrees in agent config (paths + labels)
2. Agent creates missing worktrees on startup
3. Control plane learns inventory via `host:register`
4. Scheduler assigns sessions to idle matching worktrees ([round-robin](aws.md#scheduler))
5. Setup script (if configured) resets branch/state, then the daemon installs workspace
   dependencies automatically at **session start** ([below](#setup-scripts))
6. Worktree is reused across sessions (not deleted after each run)

### Ref checkout recovery

Daemon startup preflights the installed Git version for this recovery path. Git 2.36+ is required
because repair uses `git fetch --refetch`; an incompatible daemon registers its bounded readiness
reason for operators but refuses assignments and is excluded by the scheduler.

For a worktree session, the daemon resolves its `ref` to a commit before
detaching `HEAD`, so branch names, SHAs, lightweight tags, and annotated tags
all land on the exact target commit. If both detached-checkout forms fail, it
checks that target commit's object connectivity. Only an incomplete graph gets
one repair attempt: refetch every configured remote with `--refetch`, then
retry the detached checkout. Ordinary checkout failures do not trigger a
network retry.

### Labels

Same model as GitHub Actions runner labels:

- Session `requiredLabels: ["codex"]` → worktree must include `codex`
- Worktree `["codex","claude"]` can run either
- `requiredLabels: []` → any worktree
- Multiple labels → **all** required (AND)

### Setup scripts

Host inventory can declare `requiredEnvironment` at the host root and on each repository
attachment. Names must use environment-variable syntax and be unique within each list. The daemon
reports only the names visible to repository child processes—never their values. The control plane
combines the host and repository requirements, exposes `ready` and `missing` names per attached
repository in host status, and will not assign work to a host until all names are present. A
host/repository pair may require up to 256 distinct names; the bounded runtime report allows up to
512 names so baseline child variables do not consume that requirement capacity.

Configure these lists with the structured Host Advanced and repository-attachment settings forms.
Adding a name to the service environment is insufficient unless it is also permitted by
`HARNESS_CHILD_ENV_ALLOWLIST` (baseline child variables remain available automatically).

Setup is opt-in: the daemon does **not** source `.zshrc`, `.bashrc`, or any other shell startup file
by default. Configure a host-wide script, repository/worktree scripts, terminal hooks, and
host-local `allowedRoots` with `PUT /api/v1/hosts/:hostId/exec-config` (`fleet:exec-config`).
Ordinary `PUT /inventory` preserves omitted exec-config fields.

```json
{
  "setupScript": "source \"$HOME/.zshrc\"",
  "allowedRoots": ["/home/harness"],
  "repositories": [
    {
      "id": "repo-abc",
      "setupScript": "pnpm install",
      "terminalHookScript": "/home/harness/hooks/done.sh"
    }
  ]
}
```

When `allowedRoots` is set, the daemon `realpath`s inventory filesystem paths and terminal hook
paths (including at worktree claim and hook spawn) and refuses anything outside those roots.
Unset or empty roots apply no extra restriction. Catalog command argv is not checked against
these roots. Control-plane inventory and exec-config writes reject a relative `terminalHookScript`;
an unchanged legacy relative hook is preserved only for compatibility, while new or changed hooks
must be absolute. An empty string clears the stored hook. If a polled `allowedRoots` policy makes
the current repository or worktree paths invalid, the daemon immediately re-registers as draining
and refuses assignments; it continues polling and resumes only after a valid inventory applies.

For a fresh session, the host script runs first, followed by one effective scoped script using the
existing precedence `session assignment > worktree > host/repository attachment`. Both run in the
session cwd (worktree or main). They use `$SHELL` when it names an available POSIX-compatible shell
(`sh`, `bash`, `dash`, `ksh`, or `zsh`), otherwise `/bin/sh`.

Exported variables flow from the host script into the scoped script and then into the provider
process. The daemon captures that environment through a mode-0600 temporary file, removes the file
before the session continues, and never writes the captured values to logs or session metadata.
The reserved `HARNESS_*` namespace is always removed before provider launch. Because the provider
can read every other exported value, setup scripts are trusted operator code; sourcing a broad shell
profile may expose all of its exports to repository work. A successful script that replaces the
shell and bypasses environment capture fails setup rather than launching the provider with a stale
environment.

Examples:

```bash
git fetch && git reset --hard origin/main && pnpm install
```

```bash
git checkout -b claude/auto-harness/$(date +%s) && git fetch && git reset --hard origin/main && pnpm install
```

```bash
source /home/harness/.env.codex && git fetch && git reset --hard origin/main
```

Non-zero exit → session `failed`, worktree released.

Resume sessions continue to skip every setup script so a destructive setup cannot reset the
conversation's existing worktree.

### Workspace dependency install

After any configured setup scripts finish, the daemon checks the session cwd for a root
`pnpm-lock.yaml`. If one is present it runs
`pnpm install --frozen-lockfile --ignore-scripts --ignore-pnpmfile --modules-dir node_modules
--store-dir <HOME>/.auto-harness-pnpm-store --virtual-store-dir node_modules/.pnpm
--package-import-method copy`
there before the provider launches — no operator configuration needed beyond `pnpm` being
resolvable on the daemon service user's `PATH`, the same [CLI not found](#cli-not-found) trap
that applies to provider CLIs (nvm users: point the unit file at a stable node/bin path).
Non-pnpm repositories (no lockfile) are
unaffected. Like a setup script, this step is skipped entirely on resume, and a non-zero exit,
timeout, or cancellation fails the session (`errorCode: "setup_failed"`, worktree released)
rather than launching the provider against an incomplete `node_modules`. A rejected process
launch (for example `pnpm` missing from `PATH`) is handled the same way: `SessionRunner`'s
outer catch converts it to the same `setup_failed` result and still releases the worktree.

`--frozen-lockfile` refuses to mutate the lockfile: a lockfile that disagrees with `package.json`
at the checked-out ref fails setup instead of silently drifting or dirtying the worktree.

`--ignore-scripts` and `--ignore-pnpmfile` are both mandatory, not configurable: the checked-out
ref can be chosen by a repository-scoped (non-admin) session author, and this install runs before
the provider's sandbox launches. Without `--ignore-scripts`, a
`preinstall`/`install`/`postinstall`/`prepare` script in that ref would execute arbitrary code as
the daemon user. `.pnpmfile.cjs` hooks (`readPackage`, `afterAllResolved`, ...) run as part of
pnpm's own resolution logic rather than as an npm lifecycle script, so `--ignore-scripts` alone
doesn't stop a `.pnpmfile.cjs` committed to that ref from doing the same thing; `--ignore-pnpmfile`
closes that separately. Either flag missing would bypass the admin-only arbitrary-execution
boundary that `fleet:exec-config`/`catalog:write` draw around setup scripts and command argv (see
[roles.md](roles.md)). A repository that genuinely needs those scripts can run them through its
admin-configured `setupScript` instead.

`--modules-dir`, `--store-dir`, and `--virtual-store-dir` are pinned explicitly for the same
reason: pnpm also reads all three from a project `.npmrc`, and (confirmed against the pinned
`pnpm@10.28.2`) a checked-out `.npmrc` setting `store-dir`/`modules-dir` to an arbitrary absolute
path makes the daemon write dependency state there — as the daemon user, before the provider
sandbox starts — the same boundary the scripts/pnpmfile flags protect. CLI flags outrank project
`.npmrc`, so passing them explicitly closes the redirect. `--modules-dir`/`--virtual-store-dir` are
pinned to pnpm's own **relative** defaults (`node_modules`, `node_modules/.pnpm`), not an absolute
path resolved against the session `cwd`. That distinction matters for a real workspace: pnpm
resolves `modules-dir`/`virtual-store-dir` per workspace package, so each of `modules/*`/`services/*`
normally gets its own `<package>/node_modules` symlinked into the shared `.pnpm` virtual store for
workspace-internal deps (for example `@auto-harness/shared`). Pinning an absolute value collapses
that per-package resolution — verified against a full workspace install with the pinned pnpm: every
workspace package's `node_modules` goes uncreated and workspace-internal imports become
unresolvable, which is the exact class of failure this install step exists to fix. The relative
literals still take CLI precedence over a malicious `.npmrc` (same verification, redirect attempt
has no effect) while reproducing pnpm's default per-package linking topology exactly. `--store-dir`
has no such per-package resolution — one shared content-addressable store covers the whole
install — so it stays pinned to a fixed absolute path under the daemon's own (session-independent)
`HOME` rather than pnpm's platform-specific default location, anchored somewhere a checked-out
`.npmrc` cannot move it away from. Because that differs from pnpm's usual platform default, the
first install after this pin takes effect is a cold store (full download); every install after
that — same worktree or a fresh one — reuses the warm store exactly as before.

`--package-import-method copy` closes a separate hole in that shared store
([#350](https://github.com/jonathanong/auto-harness/issues/350)). The store being shared across every
worktree on the host is not itself the bug — the bug is pnpm's default `auto` import method, which
resolves to `hardlink` on filesystems without clone/reflink support (confirmed against the pinned
`pnpm@10.28.2`: forcing `hardlink` reproduces it, while macOS/APFS's `auto` default of `clone` does
not). Under hardlink, every worktree's copy of an unchanged package is the _same inode_ as the
store's copy, not an independent file, so a write to it anywhere — a session patching a dependency
while debugging, a partial/corrupted write, anything that touches the file in place — mutates every
other worktree's copy and the store entry itself, instantly and with no revalidation, for as long as
those other sessions keep running (verified the same way: a mutation in one worktree was immediately
visible from a second, already-installed worktree sharing the store). Per [plan.md](plan.md)'s D9,
the daemon does not sandbox worktrees from each other at the OS level, so this is exactly the kind of
boundary the CLI's own writable-root configuration is supposed to hold — and hardlinking silently
defeats it regardless of `--frozen-lockfile`, which guards what pnpm resolves to install, not what a
process does to the files afterward. A later fresh install elsewhere against the same store does
self-heal (pnpm re-verifies content against the lockfile's integrity hash and refetches on a
mismatch, confirmed the same way), so exposure is bounded to worktrees already running at mutation
time, plus a resumed session, which skips this install step entirely and so never gets a chance to
self-heal. Since Auto Harness explicitly supports multiple worktrees running sessions concurrently on
one host, that window is real. `copy` rather than `clone-or-copy`: reflink is copy-on-write and
equally write-isolated where the filesystem supports it, but an unconditional copy removes the
platform split entirely — one import method to reason about instead of "clone here, copy there" —
which is worth more than the throughput `clone-or-copy` would preserve on macOS. Like the three flags
above, `package-import-method` is also `.npmrc`-settable, so pinning it on the CLI closes the same
checked-out-`.npmrc` override vector.

The real cost: on the filesystems where `auto` was already resolving to `hardlink` (Linux/ext4,
including the `ubuntu-latest` CI runners), `copy` gives up cross-worktree dedup — every worktree's
`node_modules` now holds an independent on-disk copy of each package instead of sharing an inode
with the store, so disk usage scales with worktree count rather than with distinct packages, and
each install's linking step does more I/O than a hardlink would (the network fetch is unaffected —
the store itself stays warm and shared). That's acceptable: the number of worktrees concurrently
active on one host is small and operator-controlled, not something an untrusted ref can inflate, and
`--ignore-scripts` already means there is no downstream build step whose latency this would
compound.

What this does _not_ close: the daemon's session process and every worktree's install run as the
same OS user (D9 — no per-session OS sandboxing), so a session that deliberately wants to corrupt
the shared store can still do so by writing into `storeDir` directly, bypassing a worktree's linked
copy entirely. `--package-import-method copy` removes the _incidental_ aliasing path — an in-place
mutation of a file that used to be silently shared through a hardlink, plus the `.npmrc`-forced
override — not same-uid direct writes to the store. Closing that would need the store mounted
read-only outside the install step, [#350](https://github.com/jonathanong/auto-harness/issues/350)'s
second suggested option, which is out of scope for this fix.

Pinning the flag going forward does not retroactively fix a worktree whose `node_modules` was
already materialized under a different import method — every worktree that existed before this fix
deployed, since `hardlink` was pnpm's `auto` default here. Confirmed against `pnpm@10.28.2`: rerunning
`--frozen-lockfile` against an unchanged lockfile hits pnpm's "Already up to date" fast path (see
below) and skips revisiting already-linked files entirely regardless of the requested import
method — the linked file keeps the exact same inode before and after switching `hardlink` to `copy`
with nothing else different. The daemon closes this by recording which import method most recently
completed a successful install in each worktree, in a marker file at
`node_modules/.auto-harness-package-import-method` (confirmed pnpm neither prunes nor otherwise
touches this file on a normal or forced install). When the marker is missing (a worktree from before
this fix, or an interrupted install) or stale (a future change to the pinned import method), that one
install additionally passes `--force`, which does revisit and relink every package — confirmed the
same way against both a single-package repro and this repo's own multi-package workspace, including
that `--force` preserves the per-package `link:` topology from the `modules-dir`/`virtual-store-dir`
section above rather than collapsing it. Confirmed to relink already-resolved packages from the
already-warm store (`reused`, not `downloaded`) — but not a strict "no network" guarantee: a lockfile
carrying platform-specific optional dependencies (native-binary build tooling like `rollup` or
`esbuild`, one entry per OS/arch) can have entries this worktree's store never needed before, and
`--force` does fetch those from the registry. Those extra fetches only populate the shared store —
confirmed they are never linked into any package's `node_modules`, so the worktree's own footprint and
resolution are unaffected — making the real cost a one-time, bounded amount of extra network I/O on
that worktree's first post-deploy install, not a recurring one. Later installs in that worktree return
to the cheap fast path once the marker is rewritten after a successful install; a failed install
leaves the marker untouched, so the next attempt forces again. A resumed session skips this install
step entirely (the same gap the `copy` pin itself has, described above), so a worktree whose sessions
are only ever resumed — never freshly run — stays on its old import method until a fresh run finally
forces the migration. The marker is not itself a trust boundary: it lives in `node_modules` under the
same same-uid limitation already conceded above, so a session could forge it to suppress its own
worktree's next `--force` — but that session could already reach the same outcome more directly, by
writing into `storeDir` itself.

The marker's fixed, well-known path inside an untrusted checked-out worktree is a stronger threat
than a session merely forging its contents, though: a ref can commit the marker as a symlink to any
other file the same-uid daemon process can write, and `writeFileSync`'s default behavior follows
symlinks — so the write after a successful install (not just the read before one) was reachable
before that session's provider sandbox even starts
([#350](https://github.com/jonathanong/auto-harness/issues/350) Codex review; reproduced against the
pinned pnpm — a forced relink still preserves a committed marker symlink rather than replacing it).
The daemon now `lstat`s the marker on read and unlinks it on write rather than following it: a
symlinked marker reads as absent (only ever costs an extra `--force`, never wrongly skips one), and a
write always removes whatever is at the marker path first, so it only ever creates a fresh regular
file instead of truncating a symlink's target.

The marker also assumes the daemon's own pinned install is the only thing that could have touched
`node_modules` since it was last written, which doesn't hold for a worktree with a configured setup
script: setup scripts run _before_ this install step, and a setup script is arbitrary admin-configured
code that can invoke its own unpinned `pnpm install`. If the checked-out ref's lockfile changed, that
install links the new packages under pnpm's `auto` default while the marker still claims `copy` from
a prior daemon-run install, so this step would wrongly trust the stale marker and skip `--force` even
though the setup script may have just re-aliased those specific packages
([#350](https://github.com/jonathanong/auto-harness/issues/350) Codex review). The daemon now
invalidates the marker immediately before running any setup script, so the post-setup install always
forces a relink whenever a setup script ran — scoped to that case rather than forcing every install,
to keep the fast-path throughput benefit above for the more common case of no setup script.

The lockfile check reruns after setup scripts, not before: a setup script can check out a
different ref and add or remove the lockfile, so the pre-setup snapshot can't be trusted. `CI=true`
is forced for this step only — a reused worktree's `node_modules` can need a purge-and-recreate,
which pnpm refuses without a TTY unless CI mode is set, and the daemon never attaches one. The
install step also gets its own remaining-time budget computed after the setup-script loop
completes (capped at 600s), rather than inheriting whatever was left of the setup loop's shared
deadline — a slow setup script no longer starves the install of time it would otherwise have had.
On Windows the install runs through
`cmd.exe /d /s /c pnpm install --frozen-lockfile --ignore-scripts --ignore-pnpmfile --modules-dir
... --store-dir ... --virtual-store-dir ...` rather than a bare `pnpm`, since Node's
`child_process.spawn` (`shell: false`) cannot execute a `.cmd` shim directly.

Two known gaps remain out of scope for this step and are tracked separately: pnpm can still be
hijacked on Windows by a ref-committed `pnpm.cmd`/`.bat`/`.exe` ahead of the daemon's real pnpm on
`PATH` (`cmd.exe` searches the untrusted checkout `cwd` before `PATH`), and a `file:`/`link:`
dependency in the ref's manifest or lockfile can still pull files from outside the claimed checkout
_into_ `node_modules` even with the writable directories pinned above — pinning where pnpm writes
doesn't constrain what a dependency specifier tells it to read from. Both are instances of the same
"bare argv0 + untrusted cwd" class that also reaches `git` invocations during checkout, not
something this install step alone can close — tracked in
[jonathanong/auto-harness#349](https://github.com/jonathanong/auto-harness/issues/349).

Because worktrees are reused across sessions, a repeat install on an already-installed worktree
whose lockfile hasn't changed is a near no-op (roughly a second): pnpm detects `node_modules` is
already up to date with the lockfile and skips resolution and linking entirely (`Lockfile is up to
date, resolution step is skipped` / `Already up to date` — confirmed against the pinned
`pnpm@10.28.2` with `--package-import-method copy`, so this fast path does not depend on the store's
hardlink-vs-copy import method). That near-no-op claim does not hold for the one migration install
covered above: a worktree whose marker is missing or stale pays the full `--force` relink cost once,
not the cheap fast path. A first install on a fresh worktree, or one whose lockfile changed,
still pays the full linking cost, reusing the warm content-addressable store (under the preserved
`HOME`) rather than re-downloading. A setup script that already runs its own `pnpm install` (as in the
examples above) is unaffected — this step reruns after it and finds nothing to change.

### Disk layout (example)

```text
/home/harness/
├── .env                          # HARNESS_HOST_ID, HARNESS_API_URL, HARNESS_API_KEY
├── .env.codex                    # chmod 600 — AI CLI credentials
├── repos/
│   └── my-app/                   # main checkout (paths configured via API/UI)
│       ├── .git/
│       └── .worktrees/
│           ├── wt-1/
│           └── wt-2/
└── harness/                      # cloned auto-harness monorepo (agent code)
```

Host inventory (repo paths, worktrees, attached Provider Accounts) is **not** a local file — configure with `PUT /api/v1/hosts/:hostId/inventory` or the Agents UI. Setup scripts, terminal hooks, and `allowedRoots` use `PUT /api/v1/hosts/:hostId/exec-config`. Commands themselves live in the global Provider/Provider Account/Command catalog, not host inventory.

---

## Session Lifecycle (agent view)

```mermaid
stateDiagram-v2
    [*] --> Assigned: session:assign
    Assigned --> ClaimWorktree: worktreeId set
    Assigned --> AcquireLock: worktreeId null
    ClaimWorktree --> Setup: claimed
    AcquireLock --> Setup: lock held
    Setup --> Running: setup ok
    Setup --> Failed: setup fail
    Running --> Completed: exit 0
    Running --> Failed: exit != 0
    Running --> TimedOut: timeout
    Running --> Cancelled: session:cancel
    Completed --> [*]: release
    Failed --> [*]: release
    TimedOut --> [*]: release
    Cancelled --> [*]: release
```

### Inbound `session:assign` (typical fields)

```json
{
  "type": "session:assign",
  "sessionId": "sess-x1y2z3",
  "repositoryId": "repo-abc",
  "prompt": "Fix the failing test",
  "resolvedArgv": ["codex", "exec", "Fix the failing test"],
  "timeout": 1800,
  "worktreeId": "wt-1",
  "setupScript": "git fetch && git reset --hard origin/main && pnpm install"
}
```

`worktreeId: null` → scheduled/main checkout path.

The capability-gated scheduled form is explicit on the wire:

```json
{
  "type": "session:assign",
  "sessionId": "sess-maintenance",
  "sessionType": "scheduled",
  "repositoryId": "repo-abc",
  "prompt": "Run daily maintenance",
  "resolvedArgv": ["pnpm", "lint:fix"],
  "timeout": 1800,
  "worktreeId": null
}
```

The durable `(host, repository)` lease is acquired before this frame is sent
and is retained through the reconnect grace period. The daemon additionally
serializes main-checkout execution with its per-repository mutex.

### Queue behavior (what the agent sees)

The agent does **not** pull a global queue. It only:

1. Accepts `session:assign` when the control plane chooses this worktree/agent
2. Reports idle via status/release so the control plane can **drain** the next queued session

If all matching worktrees are busy (possibly on other agents), the session stays `queued` in DynamoDB until capacity frees. Multi-agent **match then round-robin** is entirely control-plane logic ([aws.md](aws.md#scheduler)).

---

## Non-Worktree Sessions (Scheduled)

|                | Worktree session          | Non-worktree session              |
| -------------- | ------------------------- | --------------------------------- |
| Runs in        | Dedicated worktree        | Main repo checkout                |
| Concurrency    | Parallel (1 per worktree) | Serial (1 per repo on this agent) |
| Typical use    | AI coding prompts         | Maintenance scripts               |
| Created by     | API, UI, webhook          | Schedules, manual trigger         |
| Session `type` | `prompt`                  | `scheduled`                       |

Example maintenance commands (fixed scripts preferred):

```bash
git pull && pnpm install
pnpm lint:fix && git add -A && git commit -m 'chore: lint' && git push
pnpm audit fix && git add -A && git commit -m 'chore: security' && git push
```

Before a scheduled run, the daemon requires the main checkout to be clean,
including untracked files, and switches to `ref` or the configured default
branch without detaching or resetting. Scheduled refs are branch names; tags
and commit SHAs are rejected. A configured setup script is trusted operator
code and runs inside this locked main checkout, so destructive setup belongs
only in an explicitly chosen maintenance policy.

Capable daemons advertise `scheduled-main-checkout` during registration. The
control-plane dispatcher is deployed only after this capability, and excludes
older daemons that omit it.

---

## Auto-update target (graceful restart)

The daemon's drain protocol and signed-manifest orchestration core support the safety invariants below
without interrupting in-flight AI CLI work. Production manifest fetching, artifact installation, and
supervisor restart adapters are not wired yet, so the end-to-end auto-update path remains a target;
operators currently follow [the manual update runbook](deploy-host-daemon.md#update).

### Goals

| Goal                      | Behavior                                                                           |
| ------------------------- | ---------------------------------------------------------------------------------- |
| No new work during update | Agent enters **draining** — stops accepting new jobs                               |
| Finish current work       | In-progress sessions run to completion (or their normal timeout / explicit cancel) |
| Safe restart              | Process exits and restarts **only after** active sessions finish                   |
| Do not kill CLIs          | Auto-update **never** sends signals to in-process CLI commands                     |

This is different from session **cancel** or **timeout**, which intentionally stop a single session’s process.

### Flow

```mermaid
sequenceDiagram
    participant Updater as Update trigger
    participant Agent as Agent process
    participant AWS as Control plane
    participant CLI as In-flight CLIs

    Updater->>Agent: Update available (or drain + restart requested)
    Agent->>AWS: host:status { draining: true }
    AWS-->>Agent: host:draining (durably committed for this connection epoch)
    Agent->>Agent: Enter draining mode
    Note over Agent,AWS: Reject / ignore new session:assign
    Note over AWS: Scheduler skips this agent’s worktrees

    loop Until active sessions = 0
        CLI-->>Agent: logs / eventual exit
        Agent->>AWS: session:log / session:status
    end

    Agent->>AWS: disconnect (optional clean close)
    Agent->>Agent: Exit 0
    Updater->>Agent: Start new binary / systemd restart
    Agent->>AWS: connect + host:register
    Note over Agent: draining = false - accept assigns again
```

### Steps (agent)

1. **Detect update** — e.g. package updater, `auto-harness-agent update`, or `SIGUSR1` / systemd `ExecReload` mapped to drain-then-restart (not hard kill).
2. **Enter draining**
   - Send `host:status` with `draining: true` and wait for the control plane's durable `host:draining` acknowledgement before setting the local flag or refusing assignments
   - If the write/acknowledgement cannot complete, do not exit: keep the daemon alive and retry safely. A reconnect registers with `draining: true`, so it cannot briefly restore schedulable capacity while the acknowledgement is retried
   - Stop listening for **new** jobs: do not `session:ack` new assigns; if an assign arrives, reply with a drain nack (or ignore so control plane retries elsewhere after timeout — prefer explicit nack so the session stays queued for other agents)
3. **Keep running current jobs**
   - Continue log streaming, timeout watches, and cancel handling for sessions already claimed
   - **Do not** SIGTERM/SIGKILL child CLIs as part of the update path
4. **Wait for drain**
   - When active session count hits zero (all worktree + main-checkout jobs finished), proceed
   - Optional max drain wait (config); if exceeded, **still do not kill CLIs by default** — log a warning and keep waiting, or only force-exit if an operator opts into an unsafe flag (not the default auto-update path)
5. **Restart**
   - Exit cleanly (code 0)
   - Supervisor (systemd `Restart=always`, or updater) starts the new version
   - New process connects, `host:register` with inventory and no `draining` flag (equivalent to `draining: false`)

### What auto-update must not do

- Kill or reparent-kill in-process CLI commands to “hurry” the update
- Accept new `session:assign` while draining
- Leave the control plane thinking idle worktrees are schedulable while draining

### Control plane during drain

See [aws.md — Agent draining](aws.md#agent-draining). Summary: treat the agent as **online for existing sessions only**; exclude its worktrees from the idle candidate set for **new** assigns until re-register without draining.

### Relation to systemd

| Signal / action             | Intended behavior                                                                                                     |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Auto-update / drain restart | Drain → wait for jobs → exit → start new version                                                                      |
| `systemctl restart` (hard)  | Prefer configuring the unit so stop uses drain (long `TimeoutStopSec`) rather than immediate kill of the process tree |
| `session:cancel` / timeout  | May kill **that** session’s CLI only — unrelated to update                                                            |

Recommended: `TimeoutStopSec=` long enough for typical session length (or unbounded drain with a high limit), and `KillMode=mixed` / avoid killing the whole cgroup’s children before the agent has drained — the agent should own child lifecycle except on explicit cancel/timeout.

---

## Disconnect and Crash Recovery

| Scenario                        | Agent behavior                                                                     | Control plane (see aws.md)                                                 |
| ------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Network blip                    | Reconnect backoff; re-register; keep local processes running                       | Rebind connection; reconcile running sessions                              |
| Agent process crash             | systemd restarts agent; in-flight children may be orphaned                         | After grace, mark stale running sessions timed_out/failed                  |
| **Auto-update / drain restart** | Stop new jobs; finish current CLIs; exit; restart — **no kill of in-process CLIs** | Skip agent for new assigns while `draining`; re-register restores capacity |
| Clean shutdown (operator stop)  | Same drain path as auto-update when possible                                       | Worktrees offline until re-register                                        |
| Mid-session host reboot         | Same as crash                                                                      | Sessions not auto-moved to another agent (disk state is local)             |

Force-killing the agent process (OOM, `kill -9`) is **not** the auto-update path and may orphan CLI children.

On re-register, include:

```json
{
  "type": "host:register",
  "hostId": "vps-prod-1",
  "capabilities": {
    "features": ["scheduled-main-checkout"],
    "maxConcurrentAssignments": 4
  },
  "providerAccountReadiness": [
    { "providerAccountId": "acct-claude-work", "ready": true, "fingerprint": "…" }
  ],
  "worktrees": [
    {
      "id": "wt-1",
      "name": "wt-1",
      "repositoryId": "repo-abc",
      "labels": ["codex"],
      "status": "busy",
      "currentSessionId": "sess-…"
    },
    {
      "id": "wt-2",
      "name": "wt-2",
      "repositoryId": "repo-abc",
      "labels": ["codex"],
      "status": "idle"
    }
  ],
  "runningSessions": ["sess-…"]
}
```

---

## Resource Planning

| Workloads                  | Guidance                                                                         |
| -------------------------- | -------------------------------------------------------------------------------- |
| 1–2 concurrent AI sessions | ≥ 2 vCPU, 4 GB RAM                                                               |
| 3–4 concurrent             | ≥ 4 vCPU, 8 GB RAM                                                               |
| Disk                       | Worktrees duplicate working trees; size ≈ N × repo checkout + git objects shared |
| Open files / PIDs          | AI CLIs + node can be noisy; raise `LimitNOFILE` in systemd if needed            |

Concurrency knobs: **number of worktrees** in config (not a separate thread pool size).

---

## Security (agent host)

- Dedicated non-root user (`harness`)
- API key and AI keys only on the VPS; never in session prompts
- `chmod 600` on env files
- SSH key auth only; firewall: outbound 443, inbound SSH restricted
- Prompt text is untrusted input: never `shell: true` with string interpolation
- Docker group membership is root-equivalent — grant only if required

Full matrix: [security.md](security.md). Agent API key binding: [auth.md](auth.md#vps-agent-authentication).

---

## Troubleshooting

### WebSocket connection failures

```text
ERROR: Failed to connect to wss://...
```

- Check `HARNESS_API_URL` and API stage
- Validate API key and `boundHostId` match `hostId`
- Outbound TCP 443 / corporate proxy

### Git worktree errors

```text
ERROR: Failed to create worktree at /path/wt-1
```

- Parent repo must already be cloned at `repositories[].path`
- Permissions for agent user
- `git worktree prune` for stale locks
- Git ≥ 2.36 (supports checkout recovery for incomplete object stores)

### CLI not found

```text
ERROR: CLI tool not found: codex
```

- Install tool for the **same user** as systemd
- Fix `PATH` in the unit file (nvm users: point at a stable node/bin path)
- `su - harness -c "which codex"`

### High memory

- Reduce worktree count
- `systemctl status` / `ps` / `htop`
- One heavy CLI per worktree is expected

### Session stuck busy after kill

- `auto-harness-agent status`
- Restart agent (releases local claims on clean start if no process)
- Control plane may still show busy until disconnect reconciliation or status fix

### Sessions stay queued, host reports healthy

```text
GET /hosts → online: true, gitReady: true
```

No control-plane error, no error from `status`. Sessions just stay `queued` and never move to
`running` — until `queueExpiresAt` (default `queueTtlSeconds`: 8 days), when the scheduler
transitions them to `failed` with `errorCode: queue_expired` on its own; installing the profile
after that point does not revive them; submit a new session instead. In this exact failure mode —
no host advertises readiness for the account at all — the control plane's own placement check
(`hostProviderAccountReady`, in `queue-placement-planner.ts` and `control-plane-scheduled-assign.ts`)
filters the account out before a `session:assign` message is ever sent, so the daemon never runs
`handleAssign` and never logs a refusal either. That local log line only fires for a narrower
late-readiness race (advertised ready, then refused by the time the assign message arrives) — don't
search for it as evidence of this failure mode; there is no local or control-plane trace here at all.

- Cause: `HARNESS_EXECUTION_PROFILES` is unset, or missing an entry for the account a session
  needs. Assignment is fail-closed by design (see [Config Loader](#config-loader)) — with no
  advertised readiness for that exact Provider Account ID, the daemon refuses the assignment with
  no ACK and no control-plane-visible error. The host keeps reporting healthy because registration
  and Git worktrees are unaffected.
- Fix: set `HARNESS_EXECUTION_PROFILES` to an absolute-path JSON file mapping every attached
  Provider Account ID (not Provider ID — see [api.md](api.md) `/provider-accounts`) to a `home`
  directory that exists on the host. Apply with `install-service`, which persists the env var and
  restarts the daemon in one step — see
  [deploy-host-daemon.md#provider-execution-profiles-required-for-provider-backed-dispatch](deploy-host-daemon.md#provider-execution-profiles-required-for-provider-backed-dispatch).
  (The generic `#deploy-install` walkthrough only sets identity variables — it will reinstall
  without ever touching `HARNESS_EXECUTION_PROFILES`.) On Linux, the file must also be _readable_
  by the `harness` service user, not just present — see the readability note in
  [deploy-host-daemon.md#provider-execution-profiles-required-for-provider-backed-dispatch](deploy-host-daemon.md#provider-execution-profiles-required-for-provider-backed-dispatch).
- Single-operator host running every provider CLI under one real account: point each account's
  `home` at a **distinct directory** that all resolve to the same real `$HOME`, e.g. a symlink
  farm (`execution-homes/<provider-name>` → the real home). This satisfies the daemon's
  home-uniqueness check (`parseExecutionProfiles` rejects two accounts reusing one `home`) while
  keeping a single real credential store. It buys distinct _configured paths_, not real
  credential isolation between accounts — don't reach for it if accounts actually need separating.
  No `env` override is needed when the symlink target is the CLI's real home, since each CLI's
  config directory already resolves correctly underneath it.
- Verify the fix landed: neither `status` nor `GET /hosts` expose per-account readiness, so both
  look identical whether the profile landed or not — checking them proves nothing.
  `providerAccountReadiness` is advertised in `host:register` but kept only on the live connection
  state; it is never persisted or exposed through any GET route. Two ways to actually confirm it:
  - **Pre-flight, no live session needed:** `loadExecutionProfiles`/`providerAccountReadiness` (see
    [Config Loader](#config-loader), `services/host-daemon/src/execution-profiles.ts`) read only
    `HARNESS_EXECUTION_PROFILES` from the process's own env — they don't interpret `HARNESS_ENV_FILE`
    themselves — and the persisted env file is root-owned mode `0600`, unreadable by `harness`
    directly. Extract the path as root, then run the actual check as `harness` with just that path;
    running it as your own shell instead reflects your own env and filesystem permissions, not the
    daemon's, and can report `ready: true` while the live daemon still refuses every assignment. See
    the two-step script below.
  - **Authoritative:** watch an account-specific session get picked up on _that host_ — check both
    `resolvedRoute.providerAccountId` and `resolvedRoute.hostId`, not the account alone. If the
    account is attached to more than one eligible host, the session can land on a different healthy
    host and prove nothing about the one you just repaired.

Linux pre-flight, in two steps because reading the persisted env file needs root but the readiness
check needs to run as `harness` to reflect its actual filesystem access. Don't hard-code
`/opt/auto-harness/current` as the import root: a custom `HARNESS_UPDATE_INSTALL_DIR` moves it, and
on a fresh install (or before the first release promotion) there's no `current` tree yet — the
daemon's own launcher falls back to the checkout root instead, and that fallback is re-decided live
on every daemon restart, so even the systemd unit's `WorkingDirectory=` can go stale. Reading the
running process's actual cwd via `/proc` is the only way to know the live root for certain. Likewise
don't assume a bare `node` resolves under `sudo` — its secure-path default excludes anything installed
outside `/usr/bin`, `/bin`, `/usr/sbin`, `/sbin` (nvm included), so pull the exact absolute node path
the daemon itself was installed with out of the launcher script instead:

```bash
# 1. Root reads the persisted profiles path, the live daemon's actual working root (from its
#    running process, not the static unit config), and the absolute node path baked into its
#    launcher at install time.
sudo sh <<'SCRIPT'
set -eu
profiles=$(sed -n 's/^HARNESS_EXECUTION_PROFILES=//p' /etc/auto-harness/host-daemon.env | tail -1)
pid=$(systemctl show auto-harness-host-daemon.service --property=MainPID --value)
root=$(readlink -f "/proc/$pid/cwd")
node_path=$(sed -n "s/^exec '\([^']*\)'.*/\1/p" /usr/local/lib/auto-harness/run-host-daemon.sh | head -1)
echo "PROFILES=$profiles"
echo "ROOT=$root"
echo "NODE_PATH=$node_path"
SCRIPT

# 2. As harness, run the daemon's own check against that path, using the resolved NODE_PATH and
#    ROOT from step 1 (substitute all three placeholders below). An absolute node path bypasses
#    PATH resolution entirely, so it works under sudo -u harness regardless of secure_path. The
#    release tree ships raw .ts source and runs it directly via Node's native type stripping (see
#    run-host-daemon.sh) — importing from the live root is exactly what's running.
sudo -u harness env HARNESS_EXECUTION_PROFILES=/absolute/path/to/execution-profiles.json \
  /absolute/path/to/node --input-type=module <<'NODE'
import {
  loadExecutionProfiles,
  providerAccountReadiness,
} from "/absolute/live/root/services/host-daemon/src/execution-profiles.ts";
console.log(providerAccountReadiness(loadExecutionProfiles()));
NODE
```

- Tracking: auto-harness#342.

---

## Related documents

| Doc                                          | Content                       |
| -------------------------------------------- | ----------------------------- |
| [setup.md](setup.md)                         | Install, config file, systemd |
| [local-development.md](local-development.md) | Local stack, e2e, manage UI   |
| [cli.md](cli.md)                             | Agent CLI                     |
| [websocket.md](websocket.md)                 | Message types                 |
| [aws.md](aws.md)                             | Scheduler, disconnect         |
| [architecture.md](architecture.md)           | Cross-plane flows             |
| [auth.md](auth.md)                           | Agent API key binding         |
| [security.md](security.md)                   | Host hardening                |
