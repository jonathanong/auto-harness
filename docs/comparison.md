# Comparison: Auto Harness vs. managed agent-sandbox platforms

This page compares Auto Harness against `background-agents` (public docs use the working name
"Open-Inspect"), an open-source background-coding-agent system built on Cloudflare Workers +
Durable Objects with five pluggable managed sandbox providers (Modal, Daytona, E2B, Vercel
Sandbox, OpenComputer). It is the closest public reference for this category: MIT-licensed,
2,800+ stars, dozens of contributors. Facts below are drawn from its public repository as of
2026-09; verify against its current source before relying on specifics.

This is not a scorecard. Some of what it does is out of scope for Auto Harness on purpose—see
[Deliberate non-goals](#deliberate-non-goals). Where it is simply ahead, this page says so
plainly.

## What each system is

**background-agents** spawns an ephemeral managed sandbox per session: a fresh dev environment at
a cloud provider, cloned repo, a setup/start script, then an agent harness inside it. Speed comes
from filesystem snapshots, prebuilt images, and proactive warming rather than from the sandbox
staying alive between sessions.

**Auto Harness** runs on hosts you own. A daemon holds pre-provisioned git worktrees that are
reused and never deleted between sessions. The control plane resolves a Provider/Provider
Account/Command into a complete `resolvedArgv` and pushes `session:assign` over WebSocket; the
daemon claims a worktree, hard-resets it, and spawns the CLI in a PTY.

## Structural axes

| Axis                            | background-agents                                                                           | Auto Harness                                                            |
| ------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Execution substrate             | 5 pluggable managed sandbox providers, ephemeral per session                                | your own hosts; concurrency = configured worktrees                      |
| Warm-start strategy             | filesystem snapshot/restore, prebuilt images, proactive warming                             | worktree persists; hard reset to ref, untracked files preserved         |
| Agent invocation                | Claude Agent SDK, or OpenCode (also reaches OpenAI/xAI)                                     | each vendor's own CLI, natively, no intermediary                        |
| Provider awareness              | 2 harnesses, curated model catalog                                                          | any CLI runs; usage-limit adapters for `claude`/`codex`/`gemini`/`grok` |
| Control plane                   | Cloudflare Workers + Durable Objects + D1 + R2; also runs as one containerized Node process | AWS: API Gateway + Lambda + DynamoDB + S3, via CDK                      |
| Who holds git credentials       | control plane (shared GitHub App private key)                                               | none — SSH keys/`gh` credentials live only on the host                  |
| Who holds model credentials     | control plane, brokered into the sandbox per start                                          | host only, in per-account isolated `HOME`s                              |
| Sandboxing of the agent process | provider-level isolation (the whole point)                                                  | none — trusted host, by explicit design                                 |
| Repos per session               | up to 10                                                                                    | one (worktree is repo-bound)                                            |
| Tenancy / authz                 | single-tenant, shared GitHub App, no per-user repo validation                               | six roles + capability matrix + `allowedRepositoryIds` + `boundHostId`  |

## Where they are ahead

State it plainly, no hedging:

- **Ingress.** Real Slack, GitHub, and Linear bots — @mention to start a session, auto-review on
  PR open, assign an agent to a Linear issue. Inbound webhooks with JSONPath filtering
  (`eq`/`neq`/`gt`/`contains`/`exists`), Sentry alerts, GitHub workflow-completion triggers,
  `idempotencyKey` dedupe. Auto Harness has GitHub Actions dispatch and cron plus configured Slack
  outbound delivery and durable signature-verified mention/DM intake; inbound events are pending
  until session routing and authorization are implemented (see [integrations.md](integrations.md)).
- **Human-in-the-loop surface.** Multiplayer sessions with presence, commits attributed to the
  prompting user, code-server (VS Code in the browser), a ttyd web terminal, port tunneling for
  dev servers, Playwright verification, Slack image attachments. Auto Harness gives an xterm log
  replay behind a 60-second one-time viewer ticket — deliberately thinner; see
  [Deliberate non-goals](#deliberate-non-goals).
- **Zero-machine onboarding.** Bring a sandbox provider API key; no VPS to provision or harden.
- **Multi-repo sessions and Managed Skills** — versioned, reusable instruction sets; child
  sessions for parallel decomposition.
- **Deployment portability.** The same control-plane code runs on Workers or as one containerized
  Node process with SQLite + Litestream + MinIO.
- **Community scale.** 2,800+ stars, dozens of contributors, ~8 months old with a hosted product
  site. Auto Harness is weeks old and solo. On features-per-week these are not comparable
  products; comparing them stays useful because the architectural choices are.

## Where we are ahead

- **Authorization.** Its own docs: "there's no per-user repository access validation," a shared
  GitHub App installation for every user. Auto Harness has six roles, a capability matrix
  ([roles.md](roles.md)), per-principal `allowedRepositoryIds`, `boundHostId` agent keys that
  cannot author sessions, and out-of-scope resources returning 404, not 403.
- **Blast radius.** Its control plane holds the shared GitHub App private key and every brokered
  model credential — a control-plane compromise reaches every attached repo and every connected
  account. Auto Harness's control plane holds password hashes, API-key hashes, and prompts; no
  git credentials, no vendor keys, no arbitrary-shell capability against customer code
  ([security.md](security.md)).
- **The queue.** Priority DESC → FIFO ties, sharded partitions merged K-way, GitHub-Actions-style
  `requiredLabels ⊆ worktree.labels`, per-account leases with `maxConcurrentSessions`, global
  usage-limit cooldown with failover, `concurrencyId` as idempotency key and durable lock, 8-day
  queue TTL. Its automations documentation states "only one run per automation can be active at a
  time," a 15-minute minimum cron interval, and no priority, labels, or capacity-aware placement.
- **Resume fidelity.** Native tool resume with a frozen `resumeArgvTemplate`, host+account pinning,
  setup scripts deliberately skipped, and a documented fallback-to-fresh path. Its resume model is
  filesystem snapshot/restore — a different, coarser guarantee.
- **Git checkout hardening.** Abort interrupted merge/rebase/cherry-pick, clear
  `assume-unchanged`/`skip-worktree` only on actually-flagged paths, force-detach, sync submodule
  URLs, remove stale `index.lock` only when safe to. Nobody cloning fresh into a sandbox needs any
  of this.
- **Engineering gate.** 99% coverage floor on all four metrics plus a 99% patch-coverage gate, and
  an 11-step `pnpm check` (oxlint `--deny-warnings`, ast-grep, oxfmt, TypeScript, knip,
  dependency-cruiser, lychee, no-mistakes, systemd contract).

## Native harness invocation

Auto Harness spawns each vendor's own CLI directly — no intermediary Agent SDK, no universal
harness in between. Consequences:

- **Full fidelity to vendor-native features** — `CLAUDE.md`/`AGENTS.md`, hooks, MCP config, and
  each CLI's own native resume/continue flag, none of it re-implemented or lagging behind a
  wrapper's release cadence.
- **Usage envelopes parsed from the vendor's own structured output** — Claude's
  `terminal_reason: "budget_exhausted"`, Codex's JSONL event stream, Grok's 429/402, Gemini's
  `RESOURCE_EXHAUSTED` (see [host-daemon.md — Usage limits](host-daemon.md#usage-limits-ai-vendor--cli-quotas)).
  No translation layer to fall out of sync with a vendor release.
- **No SDK dependency to track.** background-agents' `claude` harness spawns the Claude Agent SDK,
  which is Anthropic-only; it reaches OpenAI and xAI models through its `opencode` harness plus a
  `codex-auth-plugin.js` credential bridge for ChatGPT device auth. There is no Codex CLI harness
  in its tree at all — GPT-5.x Codex is driven through OpenCode wearing a ChatGPT credential, not
  through `codex exec`.

## Capacity and routing

Detection and classification: [host-daemon.md — Usage limits](host-daemon.md#usage-limits-ai-vendor--cli-quotas).
Field-level cooldown/lease mechanics: [api.md § Providers, Provider Accounts, and
Commands](api.md#providers-provider-accounts-and-commands). This section adds only what's not
already there.

- **Multiple Provider Accounts of the same Provider, on the same host, is supported today.**
  `services/host-daemon/src/execution-profiles.ts` keys a `providerAccountId → ExecutionProfile`
  map and enforces `home` directory uniqueness across every entry — two accounts cannot share a
  credential store. Each profile's realpath'd `HOME`/`USERPROFILE` is applied only to the assigned
  provider CLI; git and setup scripts keep the daemon's own home. So: two Provider Accounts under
  one `providerId`, both attached to one host's inventory, two `HARNESS_EXECUTION_PROFILES`
  entries with genuinely distinct `home` directories — registration then advertises readiness for
  both and the scheduler treats them as independent capacity (separate `maxConcurrentSessions`
  leases, separate cooldowns, round-robin between them). This is a deployment pattern, not a
  limitation of the design — see the runbook note in
  [deploy-host-daemon.md](deploy-host-daemon.md#provider-execution-profiles-required-for-provider-backed-dispatch)
  for the caveat on how to provision a second account's credentials without disrupting sessions
  already running on that host.

  Do not confuse this with the symlink-farm pattern documented in
  [host-daemon.md](host-daemon.md#sessions-stay-queued-host-reports-healthy) for the _opposite_
  case — one real account running every provider CLI. That pattern explicitly "buys distinct
  configured paths, not real credential isolation between accounts."

  One caveat that pattern does not remove: `maxConcurrentAssignments` is host-wide, and worktree
  count bounds real concurrency. A second account on one host doubles the quota pool and buys
  cooldown failover — it does not double throughput unless worktrees and RAM scale with it.

- **Re-round-robin across accounts and across providers.** A `usage_limit` pauses the exhausted
  Provider Account globally for its configured cooldown and the scheduler immediately tries the
  next eligible account or the next explicit fallback in order — Claude account A exhausted →
  Claude account B → Codex, automatically, with the session's original `queueTtlSeconds` deadline
  unchanged throughout. background-agents has no equivalent: no priority, no labels, no
  capacity-aware placement, and "only one run per automation active at a time."

## Cost comparison

**Framing: Auto Harness scales to 1.** Everything except a host is free-tier or a rounding error
at one user, one repo, one session. A managed sandbox platform has no scale-to-1 point — the meter
runs whenever a sandbox is alive, and some providers carry a monthly floor.

### Sandbox vs. owned host

Verified unit prices (2026-09; treat as inputs to verify before budgeting, not contract prices —
same discipline as [costs.md](costs.md#aws-cost-model-measured-implementation--modelled-workload)):

| Platform       | CPU                                        | Memory                                    | Notes                                                     |
| -------------- | ------------------------------------------ | ----------------------------------------- | --------------------------------------------------------- |
| Vercel Sandbox | $0.128/vCPU-hr (active only)               | $0.0212/GB-hr (provisioned, full runtime) | + $0.60/M creations; ~38% higher in `cdg1`/`sfo1`         |
| E2B            | $0.0504/vCPU-hr                            | $0.0162/GiB-hr                            | billed for full sandbox lifetime                          |
| Daytona        | $0.0504/vCPU-hr                            | $0.0162/GiB-hr                            | billed for full sandbox lifetime                          |
| Modal          | $0.1419/physical core-hr (≈$0.071/vCPU-hr) | —                                         | drops to zero when idle; the only one that can hold a GPU |
| Hetzner CX22   | 2 vCPU / 4 GB, ~€4.35/mo                   | —                                         | unmetered hours                                           |
| AWS t4g.small  | 2 vCPU / 2 GB, $0.0168/hr                  | —                                         | ~$12.26/mo unmetered                                      |

At always-on, 2 vCPU / 4 GB, 730 hr/month:

| Substrate                  | Monthly                                                            |
| -------------------------- | ------------------------------------------------------------------ |
| E2B / Daytona              | ~$120.88 ($73.58 CPU + $47.30 memory)                              |
| Vercel Sandbox             | ~$109 at 25% CPU duty; ~$249 at full duty (memory alone is $61.90) |
| Modal, billed continuously | ~$103.59                                                           |
| Hetzner CX22               | ~$4.70                                                             |

Break-even against a CX22, per month of actual agent work:

- vs. E2B/Daytona (~$0.1656/hr all-in): ~28 hours/month, ≈57 min/day
- vs. Modal ($0.1419/core-hr, idle-free): ~33 hours/month, ≈1.1 hr/day
- vs. Vercel: ~55 hours/month on the memory line alone, before any CPU

**Below roughly one agent-hour/day, a managed sandbox is cheaper than any always-on host — that is
a real crossover, not a strawman.** Above it, an owned host is roughly 20–26× cheaper, and the gap
widens with every additional worktree the same box can hold. Auto Harness targets saturated,
always-on capacity; that is exactly why it has a priority queue instead of autoscaling sandboxes —
see [Managed agent sandboxes](#roads-not-taken-managed-agent-sandboxes) below.

### Control-plane substrate

[costs.md](costs.md) deliberately refuses to convert its reference workload into a dollar total —
"no byte-size or cost measurements exist from that or any other run," "recalculate before launch."
This page keeps that discipline and states the mechanism instead of a head-to-head total (one
input, whether a Durable Object's _outbound_ sends bill as requests, is unverified — a total built
on top of that would only be able to move in one direction):

- Auto Harness's dominant control-plane cost line is **WebSocket message volume**, not compute or
  storage ([costs.md](costs.md)).
- **API Gateway bills every WebSocket message at $1.00/M, including each viewer fan-out copy** —
  the reference workload's ~81M messages/month explicitly counts "each viewer copy."
- **A Durable Object fans out from the one object that already holds every socket** (the host's
  producer connection and every browser viewer), and its request price is $0.15/M, with 1M
  included in the $5/mo Workers Paid plan (which also includes 400k GB-s duration, 25B rows read,
  50M rows written, 5 GB-month storage) — and duration is not billed while hibernating.

That's the case for [Cloudflare Workers + Durable Objects](#roads-not-taken-cloudflare-workers--durable-objects)
being the better initial fit. It is not a $/month comparison, and one should not be published
until the workload is measured.

## Roads not taken: Cloudflare Workers + Durable Objects

**It would have been the better substrate for this specific architecture, and Auto Harness is not
moving to it.** Both halves matter.

Three of Auto Harness's hardest design constraints are artifacts of the AWS services chosen, not
domain truths:

- **Invariant 12** (browser and host never share a request lifetime; never Scan `Connections` to
  reach one host) exists because API Gateway WebSocket + Lambda cannot hold a socket open across
  invocations. A per-host Durable Object _is_ the connection — addressed directly by ID, no
  `Connections` table, no fan-out invocation to push to a host, no half-open push hanging a REST
  Lambda to its 15-second timeout.
- **Agent-initiated keepalive** exists because Lambda has no persistent timer; a Durable Object
  alarm is that timer, and the WebSocket Hibernation API answers protocol pings automatically
  without waking the object — with no duration billed while hibernating.
- **`HostLocks`/`ConcurrencyLocks` and sharded queue partitions merged K-way** exist because
  DynamoDB has no serialization point. A Durable Object is single-threaded by construction, so a
  scheduler object can hold the priority queue in memory with the lock for free.

The clearest case is per-session log fan-out: one session Durable Object could hold the host's
producer socket and every browser viewer's socket, so a log frame goes host → viewers with no
DynamoDB round-trip and no per-connection push invocation.

Why not migrate, all five reasons:

1. **Scope is a rewrite, not a refactor.** ~30 route files, 21 DynamoDB table adapters, two API
   Gateway protocols, all of the CDK stack, at a 99% coverage floor.
2. **Different lock-in, not less of it.** A per-session-Durable-Object design is Cloudflare-shaped.
   background-agents proves an escape path exists (container + SQLite + Litestream + MinIO), but
   its own AWS path is explicitly partial — deployed "from a laptop today" with no CI apply — and
   its Slack/GitHub/Linear bots stay on Workers regardless.
3. **Real CPU ceilings.** 30 seconds of active CPU per request by default, 5 minutes maximum;
   alarm handlers cap at 15 minutes wall time. Fine for an all-I/O workload, but a ceiling AWS
   Lambda does not impose the same way.
4. **The AWS operations surface is already built and audited** — point-in-time recovery on all 21
   tables, SSM SecureString, KMS, per-Lambda least-privilege IAM.
5. **Better initial fit is not better next fit.** The AWS control plane is built, tested, and has a
   proven deploy/update/teardown lifecycle today.

**Revisit trigger:** if WebSocket fan-out cost or `Connections`-table complexity becomes the
leading source of production incidents, or global viewer latency becomes a real product
requirement, re-open this with a spike — not a big-bang port.

One distinction worth keeping precise: [architecture.md](architecture.md#architecture-principles)
already says AWS service choices "are constraints or implementation decisions; they may change
without changing these rules." The _specific_ prohibitions above (don't Scan `Connections`; never
`await` a host push inside a browser request) are API-Gateway-shaped and would dissolve on Durable
Objects. The _principle_ they serve — observability cannot interfere with execution — survives any
substrate. (Invariant 12 itself lives in [plan.md](plan.md), separate from the eight architecture
principles.)

## Roads not taken: managed agent sandboxes

**No — assessed and declined, not a "not yet."** The reasoning is economic, and it inverts the
whole design.

A managed sandbox is priced for **bursty, ephemeral** work: it bills by the second it is alive. Auto
Harness is built for **saturated, always-on** capacity — that is precisely why it has a priority
queue. Fixed, paid-for capacity plus a queue is the opposite economic shape from per-second billing
plus autoscale. Adopting sandboxes would mean deleting the reason the queue exists.

Secondary reasons, each independently sufficient:

- It would put a third party between Auto Harness and the CLI's real `$HOME`, and subscription
  CLIs need an unsandboxed shell with a real `$HOME`.
- It contradicts [plan.md](plan.md)'s D9 and [architecture.md](architecture.md)'s "No Docker
  wrapping the agent" design decision.
- It would move subscription credentials onto a third party's filesystem, breaking the "your VPS
  holds the tools and logins" boundary in [why.md](why.md) and [security.md](security.md).

Honest counterweight, stated in [Cost comparison](#cost-comparison) above and repeated here because
it matters: below roughly one agent-hour per day, a managed sandbox is cheaper than any always-on
host. That is not Auto Harness's workload, but the curve genuinely runs both ways — it does not
only favor owned hosts.

## Deliberate non-goals

Not missing — excluded, and stated as non-goals in [why.md](why.md) and [plan.md](plan.md):

- **Multiplayer sessions, presence.** An autonomous harness's unit of human interaction is the PR
  and the notification, not a shared cursor with someone else typing in the same session.
- **In-browser IDE or terminal for co-driving a session.** Auto Harness's log viewer exists for
  debugging a finished or running session, not for a human to sit in the loop with the agent while
  it works.
- **Port tunneling for exposing a dev server.** A byproduct of interactive, human-supervised
  sessions; out of scope for unattended work with no one watching a live preview.

If the product ever needs a human to co-drive a session in real time, that is a different product
than the one this system is: it means someone is watching, which is the case Auto Harness is built
to remove.
