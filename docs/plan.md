# Implementation Plan

This is the build-handoff document for Auto Harness. It exists so a different agent — with no
memory of how this spec came together — can pick it up and build without re-litigating decisions
that are already settled, or re-discovering correctness bugs that are already known.

**How to use this document:** this file owns _sequencing, structure, data model, and acceptance
criteria_. It does not restate layer detail — control-plane internals live in [aws.md](aws.md),
agent internals in [agent.md](agent.md), the wire formats in [api.md](api.md) and
[websocket.md](websocket.md). Section 8 lists exactly what to change in those sibling docs; do
that first, since phases below assume the amended API/data model, not the one currently written
in those files.

**Driving constraint, restated:** Auto Harness exists to spend **subscription plan capacity**
(Codex, Claude Code, etc.) on unattended coding work by driving **non-interactive CLIs**, not
Agent SDKs or pay-per-token APIs. See [why.md](why.md) and [costs.md](costs.md). Every design
choice below is in service of that — cheap coordination, not a second AI vendor account, not a
generic multi-tenant agent platform.

---

## 1. Locked decisions — do not re-litigate

These were decided against a real migration target (filaments' `codex-*` GitHub Actions
automation) and are settled. If an approach below looks more "complete" or "correct," that is not
sufficient reason to reopen it — these trade completeness for a smaller, more auditable system on
purpose. Raise it with the project owner before changing any row.

| #   | Decision                                                                                                                                                                                                                                              | Rationale                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Do not propose                                                                                                                                                                     |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | The agent holds git + AI vendor credentials and does its own GitHub writes (PRs, comments, labels) directly from the session.                                                                                                                         | A prior design considered a three-phase execute → validate → publish split (run Codex with no push credential, validate the patch in an immutable runtime, publish from a separate pristine checkout) to keep untrusted output away from any credential. That split cost real complexity for a mitigation a scoped token buys more cheaply (see D7). Deliberately dropped: _"the current system is too complex and agents keep making it over complicated."_ | A bundle/validator/publisher pipeline. Patch attestation. Split-credential jobs. A "trusted runtime" concept.                                                                      |
| D2  | There is no callback DAG. Callers `POST /sessions` and exit. Results reach humans via the **Slack session thread** and via **the agent's own GitHub writes** (opening/updating a PR, commenting a link) — not via a webhook fired back at the caller. | Repo harness callers are fire-and-forget by design ([harness.md](harness.md)); the triggering GitHub Actions job is gone by the time the session finishes.                                                                                                                                                                                                                                                                                                   | Blocking `POST /sessions` until terminal. Polling loops in the caller's CI. A generic outbound-webhook framework as a _required_ mechanism (optional, low-priority — see Phase 5). |
| D3  | Failure escalation (e.g. "Codex couldn't fix it, open an issue for a human") is an **agent-side terminal hook**: agent config points at a repo-local script, invoked with session metadata as env on every terminal status.                           | No GitHub Actions job survives to run escalation logic post-migration, so _something_ has to. Keeping it agent-side keeps escalation policy where it already lives (in the target repo, versioned with it) and keeps GitHub tokens out of the control plane. It also covers failure modes a prompt cannot see itself hit: `usage_limit`, `timed_out`, agent crash, setup-script failure.                                                                     | A rules engine or escalation templates inside Auto Harness. A control-plane GitHub App making the decision.                                                                        |
| D4  | `command` is a **named profile** resolved against agent config, not a free string passed over the API.                                                                                                                                                | A free string is a straight line from "operator role" to arbitrary command execution on the VPS, and string→argv construction is its own injection surface. Naming profiles server-side (agent-side) closes both at once and shortens the API.                                                                                                                                                                                                               | Free-form `command` strings. Shell strings. `shell: true` anywhere in the executor.                                                                                                |
| D5  | Session **resume pins to the agent only**, not agent+worktree. The worktree is re-established via `ref` (see D6) rather than kept untouched.                                                                                                          | The AI CLIs this system targets keep their own session/conversation state outside the working tree (e.g. under the CLI's own state directory), and shepherd-style flows push their commits to the remote each tick. The durable state for resume is _(CLI session id, remote branch)_ — not "don't touch this worktree." Pinning to a worktree and waiting indefinitely for it to free up is a liveness hazard for no real benefit once this is understood.  | Worktree-level pinning. Indefinite pin waits. Snapshotting or freezing a worktree to preserve state.                                                                               |
| D6  | `POST /sessions` accepts a `ref` (branch/tag/SHA) so a session can run against something other than the repo default branch.                                                                                                                          | Without it, every session's worktree gets reset to the default branch by its setup script — so a session can never operate against a specific PR head. This blocks entire trigger patterns (comment-driven PR work, dependency-bot PR fixes), not an edge case.                                                                                                                                                                                              | Solving this by making callers pre-stage the ref out-of-band, or by adding N repo-specific "PR worktree" special cases instead of one general field.                               |
| D7  | The credential the agent uses for GitHub writes is a **fine-grained token scoped to one repository**: contents + pull-requests + issues write, no Actions/workflow write, no secrets read.                                                            | This is the primary mitigation for D1 and D4 relaxing the trust boundary — a prompt is attacker-influenced (it can originate from an issue comment or embed captured CI output), so bound what a compromised session can reach.                                                                                                                                                                                                                              | Broad PATs. Org-wide App installations. Reusing a human operator's token.                                                                                                          |
| D8  | Usage-limit retry is **narrow**: only for sessions that failed with `errorCode: usage_limit`, capped at a small number of attempts, with backoff — not a general retry policy.                                                                        | Replaces an external poller that reruns whole CI jobs from artifact markers. Scope creep here (retrying `failed` or `timed_out` generally) turns a quota hiccup into a resource-burning retry storm.                                                                                                                                                                                                                                                         | Automatic retry for any non-`usage_limit` terminal status. Unbounded retry attempts.                                                                                               |
| D9  | No Docker (or other sandbox) wraps the agent process itself. The host is trusted; the AI CLI runs directly on it, subject to the CLI's _own_ sandboxing (approval policy, writable-roots, hooks) which is configured per-repo, not by Auto Harness.   | Stated existing principle ([architecture.md](architecture.md), [security.md](security.md)) — keep it explicit here so it isn't "improved" into per-session containers as part of this work.                                                                                                                                                                                                                                                                  | Per-session containers, gVisor, rootless podman, or any other isolation layer wrapping the agent or its worktrees.                                                                 |

## 2. Non-goals

Explicitly out of scope for this project, regardless of how easy any individual piece looks:

- **API-metered agent farms.** This is a subscription-capacity scheduler, not a pay-per-token
  agent platform. See [why.md](why.md), [costs.md](costs.md).
- **Replacing interactive IDE/chat use.** Auto Harness is for unattended, queued work.
- **Owning a target repo's GitHub policy.** Trigger filtering, CI-failure triage, deduplication,
  comment-author authorization, and prompt content stay in the target repo
  ([harness.md](harness.md)). Auto Harness receives a rendered prompt and a target; it does not
  decide _whether_ to run.
- **Multi-tenant SaaS.** Single-org control plane; `allowedRepositories` scoping is the extent of
  multi-tenancy, not a hard security boundary between untrusted customers.
- **Per-session containerization** (see D9).
- **A general outbound-webhook / callback framework as a required path** (see D2) — an optional
  version may land in Phase 5 for callers who want it, but no phase before that depends on it.

---

## 3. Project Structure

**Layout convention:** shared code lives in `modules/`; deployable units live in
`services/`. Dependency-cruiser forbids modules→services and service→service imports.

Layer docs: [aws.md](aws.md) (control plane `services/cdk` + `services/api`),
[agent.md](agent.md) (`services/agent`).

```
auto-harness/
├── modules/
│   └── shared/                 # @auto-harness/shared — types, constants, validation
│
├── services/
│   ├── cdk/                    # @auto-harness/cdk — AWS CDK (see aws.md)
│   ├── api/                    # @auto-harness/api — REST + WebSocket Lambda/local
│   ├── agent/                  # @auto-harness/agent — VPS daemon (see agent.md)
│   └── web/                    # @auto-harness/web — Next.js UI
│
├── docs/
├── .github/workflows/
├── pnpm-workspace.yaml         # modules/* + services/*
├── tsconfig.base.json
├── package.json
├── AGENTS.md
└── README.md
```

Target source layout inside services (as Phase 1+ lands) still follows the earlier design:
`api` owns handlers + session-service + scheduler; `agent` owns connection, executor,
worktree-manager, command-profiles, terminal-hook, etc. See Phase 1 deliverables below
(paths use `services/*` / `modules/shared`, not `packages/*`).

---

## 4. Data Model

```mermaid
erDiagram
    User {
        string id PK
        string username "unique"
        string passwordHash "bcrypt, null for service accounts"
        string role "admin | operator | read-only"
        string type "user | service-account"
        string apiKeyHash "SHA-256, service accounts only"
        string[] allowedRepositories "optional scope"
        string createdAt
    }

    Repository {
        string id PK
        string name
        string url
        string defaultBranch
        string setupScript "optional, may reference $HARNESS_REF"
        string terminalHookScript "optional, path on agent host — see Invariant-adjacent D3"
        string slackChannel "optional override"
        string createdAt
    }

    Worktree {
        string id PK
        string agentId FK
        string repositoryId FK
        string path
        string[] labels "e.g. codex, claude"
        string status "idle | busy | error"
        string setupScript "optional"
        string currentSessionId FK "nullable"
        string lastAssignedAt "nullable, used for round-robin"
        boolean online "cleared on agent disconnect"
    }

    Session {
        string id PK
        string repositoryId FK
        string worktreeId FK "nullable until assigned"
        string agentId FK "nullable until assigned"
        string userId FK
        string prompt
        string commandProfile "named profile resolved on the agent, e.g. codex-fix, claude-print"
        string ref "nullable — branch/tag/SHA to check out; default branch if omitted"
        string status "queued | running | completed | failed | cancelled | timed_out"
        string type "prompt | scheduled"
        string source "api | ui | webhook | schedule"
        number timeout "seconds, required"
        number priority
        string[] requiredLabels
        string concurrencyKey "nullable — sessions sharing a key are subject to onConflict"
        string onConflict "queue | replace | reject — default queue"
        string queueShard "assigned at create; spreads the queued-status GSI (see Access patterns)"
        object metadata "nullable — caller-supplied provenance (e.g. PR number, run id) for Slack/hook context"
        number exitCode "nullable"
        string errorCode "nullable, e.g. usage_limit, resume_failed"
        string errorMessage "nullable"
        number retryCount "usage_limit retries attempted, default 0"
        string retryAfter "nullable — ISO timestamp; cron requeues at/after this time (usage_limit only)"
        string resumedFromSessionId FK "nullable"
        string pinnedAgentId "nullable, resume affinity — agent only, no pinnedWorktreeId"
        string pinExpiresAt "nullable — pinned resume assign fails clearly past this time"
        string cliResumeRef "nullable, tool-native resume id"
        string slackThreadTs "nullable"
        string slackChannel "nullable"
        string createdAt
        string startedAt
        string completedAt
    }

    Schedule {
        string id PK
        string repositoryId FK
        string name
        string commandProfile
        string cron "5-field cron expression"
        boolean enabled
        number timeout "seconds"
        string lastRunAt "nullable"
        string nextRunAt "conditional-claim key — see Invariant 4"
        string createdAt
    }

    SessionLog {
        string sessionId PK
        string timestampSeq SK "format: <ISO-timestamp>#<zero-padded-seq> — see Invariant 5"
        string stream "stdout | stderr | system"
        string content
        number ttl "DynamoDB TTL, auto-delete after expiry"
    }

    Connection {
        string connectionId PK
        string type "agent | client"
        string agentId "nullable"
        string boundAgentId "required for agent type, validated on register"
        string userId "nullable"
        string connectedAt
    }

    AuditLog {
        string id PK
        string timestamp SK
        string userId
        string action "e.g. session:create, account:delete"
        string resourceId
        string metadata "IP, user agent"
    }

    Integration {
        string id PK "e.g. slack"
        string type "slack"
        string encryptedConfig "KMS-encrypted bot token + settings"
        string defaultChannel
        boolean enabled
    }

    User ||--o{ Session : creates
    Repository ||--o{ Worktree : has
    Repository ||--o{ Session : targets
    Repository ||--o{ Schedule : has
    Schedule ||--o{ Session : creates
    Worktree ||--o| Session : runs
    Session ||--o{ SessionLog : produces
```

**Changed from an earlier draft of this document:** `command` → `commandProfile` (D4);
`pinnedWorktreeId` removed, `pinExpiresAt` added (D5); `ref`, `concurrencyKey`, `onConflict`,
`queueShard`, `metadata`, `retryAfter`, `retryCount` added; `SessionLog` sort key changed from
bare `timestamp` to `timestampSeq`; `Worktree.online` and `Repository.terminalHookScript` added.

### Access patterns

| Access pattern                      | Table / index | Key shape                                                                           | Notes                                                                                                                                                                                  |
| ----------------------------------- | ------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Get session by id                   | Sessions      | PK `id`                                                                             |                                                                                                                                                                                        |
| List queued sessions for assignment | Sessions      | GSI `status-createdAt`, sharded: query all of `queued#0` … `queued#(N-1)` and merge | See Invariant-adjacent note below — a single `status=queued` partition is a hot-partition risk under CI-storm bursts. `N` (shard count) is a deploy-time constant; start at 4–8.       |
| List sessions by repo               | Sessions      | GSI `repositoryId-createdAt`                                                        |                                                                                                                                                                                        |
| Full-text prompt search             | —             | **not implemented in v1**                                                           | DynamoDB cannot do this without a scan or an external index (OpenSearch). Phase 4 ships filter-only; revisit only if a real need appears, with an explicit external index, not a scan. |
| Append session log chunk            | SessionLogs   | PK `sessionId`, SK `timestampSeq`                                                   | `seq` is a per-session monotonic counter assigned by the **agent** before batching; the server never reorders.                                                                         |
| Range-read logs for REST/history    | SessionLogs   | PK `sessionId`, SK range                                                            | Sort order is correct because `timestampSeq` is lexicographically ordered by construction (fixed-width zero-padded seq).                                                               |
| Idle matching worktrees             | Worktrees     | GSI `repositoryId-status` (or scan for small fleets)                                | Claim uses a conditional write — see Invariant 1.                                                                                                                                      |
| Find agent connection for assign    | Connections   | GSI `agentId`                                                                       | Conditional put on register — see Invariant 3.                                                                                                                                         |
| Due schedules                       | Schedules     | GSI `repositoryId-nextRunAt`, or scan across all repos for the cron sweep           | Claim is the conditional advance of `nextRunAt` — see Invariant 4.                                                                                                                     |

---

## 5. Invariants

These are the testable rules the implementation must uphold. Every phase's acceptance criteria
reference these by number; a phase is not done until its invariants have a passing test.

1. **Worktree claim is exclusive.** A worktree transitions `idle → busy` only via a conditional
   write (`ConditionExpression: status = :idle`). A losing writer (e.g. the create-path scheduler
   and the drain-path scheduler racing on the same idle worktree) retries against the next
   candidate instead of double-assigning.
2. **Assign has a deadline.** A session assigned to an agent (`session:assign` sent) that does not
   receive `session:ack` within a bounded ack deadline returns to `queued` and its worktree
   returns to `idle`. No unbounded "ignore" outcome is allowed to leave a worktree wedged `busy`
   forever.
3. **One live connection per agent.** `agent:register` is a conditional put keyed on `agentId`
   ("no existing connection for this `agentId`"); a stale row from a lost `$disconnect` must not
   let two connections both believe they own one agent identity.
4. **A schedule fires at most once per `nextRunAt`.** The cron evaluator's claim _is_ the
   conditional advance of `nextRunAt` (`ConditionExpression: nextRunAt = :expected`). A retried or
   overlapping EventBridge invocation must not create two sessions for the same fire.
5. **Log ordering is total per session.** Under the `(timestamp, seq)` sort key, replay and
   reconnect must never renumber or reorder previously-assigned `seq` values, including across an
   agent reconnect mid-session.
6. **`usage_limit` retry is capped and exclusive to that error code.** No other terminal status
   (`failed` without that code, `timed_out`, `cancelled`) is auto-retried. `retryCount` has a hard
   ceiling (default 2); exceeding it leaves the session terminal with no further retry.
7. **Resume assigns only to `pinnedAgentId`, on an agent-only pin, with an expiry.** Past
   `pinExpiresAt`, a still-queued pinned resume fails clearly (`status: failed`, `errorCode:
resume_failed`) rather than waiting indefinitely.
8. **No shell interpolation of untrusted input.** Prompts, `ref`, and any caller-supplied string
   are passed as argv elements or via stdin — never concatenated into a shell command string, on
   the control plane or the agent.
9. **`concurrencyKey` collisions resolve deterministically before entering the queue.** Given
   `onConflict: queue | replace | reject`, the behavior is decided at `POST /sessions` time, not
   left to the scheduler to improvise later.

---

## 6. Phases

Each phase lists **Goal → Deliverables → Acceptance criteria → Tests → Exit condition**, plus a
migration marker. **No filaments workflow may cut over before the marker on Phase 3 is met.**

### Phase 1 — Foundation

> Get one session running end-to-end on the local agent, no cloud.

**Deliverables**

- `pnpm` monorepo with workspaces; `modules/shared` with types + constants.
- `services/agent`:
  - Config loading (repos, worktrees, labels, **command profiles**, **terminal hook script
    path**) from JSON file + env vars.
  - Git worktree manager — create worktrees on startup, validate existing ones, **checkout a
    specific `ref` when the session specifies one** (D6), else the repo's default branch.
  - `command-profiles.ts` — maps a named profile (e.g. `codex-fix`) to a fixed argv template;
    rejects unknown profiles (D4).
  - Process executor — `child_process.spawn` with `node-pty`, **no `shell: true`**, prompt passed
    as argv/stdin only (Invariant 8).
  - Session runner — claim worktree → run setup script (ref-aware) → resolve command profile →
    spawn → collect output → release.
  - Session timeout — kill after `timeout` seconds, report `timed_out`.
  - Usage-limit detection — parse CLI output for quota/rate-limit text → `failed` +
    `errorCode: usage_limit` (no retry logic yet — that's Phase 2/3).
  - `terminal-hook.ts` — on every terminal status, if the repo config declares a hook script,
    invoke it with session metadata as env (`HARNESS_SESSION_ID`, `HARNESS_STATUS`,
    `HARNESS_ERROR_CODE`, `HARNESS_REF`, `HARNESS_METADATA`, worktree path); log and swallow hook
    failures, never let them change session status (D3).
  - Log streamer — buffer/emit stdout/stderr with timestamps **and a per-session monotonic
    `seq`** (Invariant 5).
- Minimal agent CLI: `auto-harness-agent start`, `auto-harness-agent status`.
- **Local API server** (`services/api/src/local-server.ts`) — Express + `ws` wrapper around the
  same Lambda handlers. REST on `localhost:7420`, WS on `ws://localhost:7420/ws`. DynamoDB Local.
  Auto-creates tables, seeds a default admin.
- Local-only mode for testing (accept sessions via local file or stdin).
- Full local stack: DynamoDB Local (Docker) + local API server + `services/web` dev server + agent
  — same code as production.
- **Testing:** vitest across packages; unit tests for session runner, worktree manager, config
  loader, command-profiles, terminal-hook; mock `child_process.spawn` / `node-pty`;
  `modules/shared` type-level assertions.

**Acceptance criteria**

- A session with `ref` set checks out that ref, not the default branch (D6, Invariant 8).
- An unknown `commandProfile` is rejected before spawn, with no shell fallback (D4).
- A terminal hook script receives correct env on `completed`, `failed`, `timed_out`, and
  `usage_limit` and its failure does not alter the reported session status (D3).
- Log chunks emitted within the same millisecond are distinguishable and correctly ordered on
  replay (Invariant 5).

**Status (local exit):** done for agent + local REST without AWS. Verify with
`pnpm check`, `pnpm local:e2e`, `pnpm local:cli-e2e` (documented CLI + `ref: main` while primary
tree is on `main`), and `pnpm local:api-smoke`.

**Deviations (intentional, Phase 1 only):**

- Local API uses **Amazon DynamoDB Local** (`docker compose` / `pnpm local:dynamodb`) via the
  AWS SDK — not a custom DB. Process cache remains for single-process coordination; durable
  rows live in DynamoDB Local (same table shapes as CDK).
- Agent `start` (WebSocket daemon) is Phase 3; local path uses `run-session` / `local:e2e` bridge.
- `services/web` remains a stub until a later UI phase.
- Checkout always detaches at the resolved SHA so a session `ref` that is already checked out in
  the primary tree (e.g. `main`) still works.

**Migration marker:** none — Phase 1 is agent-local only; nothing can cut over yet.

### Phase 2 — Cloud Infrastructure + API

**Deliverables**

- `services/cdk`:
  - DynamoDB tables per §4, including the **sharded `status-createdAt` GSI** for the queue and
    the **`timestampSeq`** sort key for SessionLogs.
  - SessionLogs TTL (7 days).
  - S3 archive bucket, API Gateway (REST + WS), Lambda functions + IAM roles.
  - CloudWatch Events rule (1-minute) for cron evaluation.
- `services/api` REST handlers:
  - Auth: login/logout, user CRUD, service account CRUD.
  - Sessions: create (**`ref`, `commandProfile`, `concurrencyKey`, `onConflict`, `metadata`
    accepted; response includes `url`**), list (`search` **omitted from v1** — see Access
    patterns), get, cancel, clone, resume (**agent-only pin**, D5).
  - Repositories: CRUD (include `terminalHookScript`).
  - Worktrees: list, get. Agents: list, get. Schedules: CRUD + manual trigger. Integrations:
    Slack config CRUD.
- `services/api` WebSocket handlers:
  - `$connect`/`$disconnect` — validate token, manage Connections table with the **conditional put
    on `agentId`** (Invariant 3).
  - `$default` — route by `type`.
  - Task dispatch: `session:assign` to agent, including `ref` when set.
  - Status/log forwarding: agent → DynamoDB, agent → subscribed clients.
  - Live log replay: buffer last 100 lines per session, replay on `session:subscribe`.
- Cron handler:
  - Due schedules via **conditional `nextRunAt` advance as the claim** (Invariant 4).
  - Creates sessions `type: scheduled`, `source: schedule`.
  - Stale-session sweep — see Phase 3 for the heartbeat-based version; a coarse
    `startedAt + timeout + grace` version is acceptable here as a placeholder but must be replaced
    before Phase 3 exits.
- Local development parity: DynamoDB Local, thin Express wrapper, mock WS server for agent dev,
  `.env.example` per package.
- **Testing:** integration tests against DynamoDB Local for every invariant in §5 that this phase
  implements (1, 3, 4, 5); API handler tests with mocked DynamoDB; WS handler tests with mocked
  API Gateway Management API.

**Acceptance criteria**

- Two concurrent `POST /sessions` racing for the same idle worktree: exactly one wins the claim,
  the other is queued or assigned elsewhere (Invariant 1).
- Two concurrent `agent:register` calls with the same `agentId`: exactly one connection row
  survives (Invariant 3).
- A cron sweep re-invoked concurrently (simulating an EventBridge retry) creates at most one
  session per due schedule (Invariant 4).
- `GET /sessions/:id/logs` replays events in insertion order even when two log-writes land in the
  same millisecond (Invariant 5).
- `POST /sessions` response includes a `url` that resolves to the session in the local Web UI.

**Status (code-complete, local parity):** `ControlPlane` implements exclusive claim (Inv 1),
agent register uniqueness (Inv 3), cron `nextRunAt` claim (Inv 4), `timestampSeq` logs (Inv 5),
session create with `ref`/`commandProfile`/`concurrencyKey`/`onConflict`/`metadata`/`url`.
CDK table defs in `services/cdk` (no live AWS deploy required in-repo). Local store is
DynamoDB Local via `pnpm local:dynamodb` (official image).

**Migration marker:** none — cloud plumbing only, no live agent assignment loop yet.

### Phase 3 — Agent ↔ Cloud Integration

**Deliverables**

- Agent WebSocket client — connect, auto-reconnect (exponential backoff, max 60s).
- **Agent-initiated keepalive**: the agent sends periodic pings (or equivalent activity) to keep
  the API Gateway WS connection alive; do **not** implement a server-originated timer-based
  `ping`, since Lambda has no persistent process to hold one (this replaces an earlier,
  unimplementable "server pings every 30s" design).
- `agent:register` on connect — worktree inventory, validated against `boundAgentId`.
- **Ack-deadline enforcement**: `session:assign` without `session:ack` inside the deadline
  requeues the session and frees the worktree (Invariant 2) — implemented in the scheduler
  service, triggered by a short-lived timer or a re-check on next scheduling pass.
- Live log streaming over WS, batched to DynamoDB via `BatchWriteItem`.
- Session status lifecycle: `queued → running → completed | failed | cancelled | timed_out`.
- Session timeout enforcement (agent-side kill + report).
- Queue management with priority; **`concurrencyKey`/`onConflict` resolution** (Invariant 9) in
  the scheduler at session-create time.
- Worktree label matching; multi-agent round-robin by `lastAssignedAt`.
- **Session resume** — pin to `pinnedAgentId` only; agent re-checks-out via `ref` +
  `cliResumeRef`/native CLI resume rather than relying on undisturbed worktree state; pin honors
  `pinExpiresAt` (Invariant 7, D5).
- **Usage-limit retry** (D8, Invariant 6): on `errorCode: usage_limit`, set `retryAfter` and
  `retryCount += 1`; the cron evaluator re-queues sessions where `retryAfter <= now` and
  `retryCount` is under the cap; never applies to other error codes.
- Reconnection recovery — re-report running sessions and worktree state; **heartbeat-based stale
  detection** replaces the coarse `timeout + grace` sweep from Phase 2 (use log/status recency,
  not just `startedAt`, so a crashed agent's worktree is reclaimed promptly rather than after up to
  the full session timeout).
- Non-worktree (`scheduled`) session execution on main repo checkout; main-checkout lock, serial
  per repository.
- **Testing:** E2E test — create session (with `ref`) → agent picks up → runs → completes, using
  DynamoDB Local + mock WS; dedicated tests for Invariants 2, 6, 7, 9; a resume test that resumes
  onto a **different** worktree path after the original was reused by an intervening session,
  proving D5 actually works.

**Acceptance criteria**

- A session assigned to an agent that never acks (simulated) returns to `queued` within the ack
  deadline and its worktree returns to `idle` (Invariant 2).
- A `usage_limit` session is automatically re-queued once `retryAfter` passes, up to the cap, and
  never beyond it (Invariant 6, D8).
- A resumed session reaches the correct `ref`/branch state even when its original worktree was
  reassigned and reset in between (D5, Invariant 7).
- Two sessions sharing a `concurrencyKey` with `onConflict: reject` — the second is rejected at
  create time, not queued (Invariant 9).
- A crashed agent's worktree is reclaimed materially faster than the full session `timeout` would
  otherwise require.

**Status (code-complete, local WS):** `AgentLoop` + **WebSocket** (`/ws` on local API,
`auto-harness-agent start`, `pnpm local:ws-e2e`) and loopback (`pnpm local:cloud-e2e`). Ack
deadline requeue (Inv 2), usage_limit retry (Inv 6), agent-only resume pin (Inv 7), concurrency
reject/replace (Inv 9), heartbeat stale reclaim. Live AWS API Gateway deploy is operational.

**Migration marker: filaments' `codex-plan` (plan-only, no publication) may cut over once this
phase's acceptance criteria pass, plus the terminal hook from Phase 1 and usage-limit retry
above are live in a real deployment.** No workflow that needs `ref`, resume, or
`concurrencyKey` may move before this phase is fully done.

### Phase 4 — Web UI

**Deliverables** — unchanged in scope from the original draft, with one correction:

- `services/web` Next.js app: dashboard, session list/detail/create, schedule management,
  repository management, settings, auth, Slack config UI — see [web.md](web.md) for full detail.
- **Session search is scoped to client-side filtering over the current page**, not a
  full-text `search` query param against DynamoDB (see Access patterns, §4) — do not implement a
  DynamoDB scan-backed search endpoint. If full-text search becomes a real requirement, it needs
  an explicit external index (e.g. OpenSearch), scoped and estimated as its own piece of work, not
  bundled into Phase 4.
- Create-session form includes **ref** and **concurrency/label** fields, and a **command profile**
  dropdown populated from agent-reported profiles (not free text).

**Acceptance criteria**

- Creating a session from the UI with a `ref` produces a session that checks out that ref.
- The command dropdown only offers profiles the target agent actually has configured.

**Status:** `pnpm local:web` serves create-session UI (ref + agent profile dropdown only; D4).
`createSessionFromUi` hits the real API. Full Next.js dashboard deferred; create path is shippable.

**Migration marker:** UI availability doesn't gate any filaments cutover — CLI/API-driven
callers don't need it. Useful before wider (non-filaments) rollout.

### Phase 5 — Polish + Advanced Features

**Deliverables** — replaces the original Phase 5, which listed items that either contradict D2/D3
(webhook triggers as an Auto Harness feature, PR shepherding as an Auto Harness feature — both are
repo-harness concerns per [harness.md](harness.md)) or are already covered earlier in this
rewrite (usage-limit retry is now Phase 3, not Phase 5):

- Session archival — DynamoDB → S3 for completed session logs.
- Optional outbound webhooks — **opt-in, not required by any documented pattern** (D2); a caller
  that wants a machine-readable callback instead of Slack/GitHub can configure one, but no phase
  before this one depends on it existing.
- Agent health monitoring — heartbeat, auto-restart detection (builds on the Phase 3 heartbeat
  work).
- Agent auto-update — drain (no new jobs), finish in-flight CLIs without kill, then restart.
- Rate limiting + cost tracking; recompute log-volume assumptions against a real CLI transcript
  before finalizing DynamoDB/S3 cost estimates (see [costs.md](costs.md) — prior estimates assumed
  roughly two orders of magnitude fewer log chunks per session than a long-running CLI session
  actually produces).
- Audit logging.

**Status:** session log archival (`archiveSessionLogs`), opt-in webhooks
(`setWebhookUrl` / deliveries), agent drain without killing in-flight CLIs (`drainAgent` +
`AgentLoop.beginDrain`).

**Migration marker:** none of this gates any filaments workflow.

---

## 7. Spec deltas to apply to sibling docs

The phases above assume these changes exist in the referenced docs. Apply them before or during
Phase 1/2 implementation — do not implement against the currently-written text where it conflicts
with this table.

| File                      | Section                                        | Change                                                                                                                                                                                                                                                      |
| ------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api.md`                  | `POST /sessions` request                       | Add `ref`, `concurrencyKey`, `onConflict`, `metadata`. Change `command` → `commandProfile` (string, must match an agent-reported profile name).                                                                                                             |
| `api.md`                  | `POST /sessions` response, `GET /sessions/:id` | Add `url` (UI deep link).                                                                                                                                                                                                                                   |
| `api.md`                  | `POST /sessions/:id/resume`                    | Remove `pinnedWorktreeId` from behavior description; document agent-only pin + `pinExpiresAt` + re-checkout-via-`ref` (D5).                                                                                                                                 |
| `api.md`                  | `GET /sessions` query params                   | Remove or caveat `search` — not implemented against DynamoDB (see §4 Access patterns).                                                                                                                                                                      |
| `agent.md`                | Executor                                       | Replace free-string `command` handling with command-profile resolution (D4); document the per-session env allowlist (don't inherit the agent user's full environment).                                                                                      |
| `agent.md`                | Worktree Manager / Setup scripts               | Document `ref`-aware checkout (D6).                                                                                                                                                                                                                         |
| `agent.md`                | Session resume                                 | Rewrite around agent-only pin (D5); remove worktree-preservation language.                                                                                                                                                                                  |
| `agent.md`                | Usage limits                                   | Replace "no auto-retry" with the narrow, capped retry described in D8/Invariant 6.                                                                                                                                                                          |
| `agent.md`                | New section                                    | Terminal hook (D3): config shape, invocation contract, env vars, failure handling.                                                                                                                                                                          |
| `aws.md`                  | Scheduler                                      | Add conditional worktree claim (Invariant 1), ack-deadline requeue (Invariant 2), `concurrencyKey`/`onConflict` resolution (Invariant 9).                                                                                                                   |
| `aws.md`                  | Cron Evaluator                                 | Conditional `nextRunAt` claim (Invariant 4); heartbeat-based stale sweep (Phase 3) replacing the coarse `timeout + grace` version.                                                                                                                          |
| `aws.md`                  | DynamoDB tables                                | Sharded queue GSI; `SessionLogs` SK becomes `timestampSeq`.                                                                                                                                                                                                 |
| `websocket.md` / `aws.md` | Keepalive                                      | Remove "server pings every ~30s" (no server process holds this timer under Lambda); document agent-initiated keepalive instead.                                                                                                                             |
| `security.md`             | New section                                    | Threat model: prompt is untrusted/attacker-influenced input; the agent-held credential is scoped per D7; state plainly what this does and does not protect against, replacing the argument the dropped validator/publisher split used to make structurally. |
| `security.md`             | Service accounts / roles                       | Note that `operator` maps to "run any configured command profile" post-D4, not arbitrary command execution.                                                                                                                                                 |
| `costs.md`                | SessionLogs cost estimate                      | Recompute against a realistic long-running CLI session's message volume, not the prior ~50-chunk assumption; note the API Gateway 128 KB frame limit and DynamoDB 400 KB item limit as constraints on prompt/log-chunk size.                                |

---

## 8. Verification

Because this is a from-scratch build, verification is staged with the phases themselves rather
than as one final pass:

1. **Phase 1 exit:** run one real prompt (borrowed from a target repo's automation) end-to-end on
   the local agent with no cloud — confirm ref checkout, command-profile resolution, and the
   terminal hook fire correctly.
2. **Phase 2 exit:** invariant-focused integration tests (1, 3, 4, 5) pass against DynamoDB Local
   under concurrent/racing conditions, not just the happy path.
3. **Phase 3 exit ("migration marker"):** the acceptance criteria in Phase 3 pass in a real
   (non-local) deployment, and a plan-only workflow can be cut over per §6's marker.
4. **Cross-doc consistency:** after applying §7's deltas, re-read `api.md`, `agent.md`, `aws.md`,
   `websocket.md` and confirm none of them still describe a behavior this document's §1 decisions
   or §5 invariants contradict (e.g. no lingering "server ping" language, no lingering
   worktree-pin resume language).
5. **Non-goal check:** before merging any addition to this plan, confirm it isn't reintroducing
   something §2 rules out (a callback framework as a required path, a rules engine for
   escalation, per-session containers).
