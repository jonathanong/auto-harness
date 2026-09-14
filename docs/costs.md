# Cost Breakdown

## Session usage reporting

Auto Harness is not a billing system. It can retain provider-neutral usage emitted by a CLI and
display operator-supplied rates as integer micros for operational reporting. It does not fetch
vendor pricing, infer usage from prompts/logs, or charge accounts. Reports are attributed to the
session, repository, provider, Provider Account, and Command and are available through scoped API
queries. Cost values remain strings to avoid floating-point rounding; mixed currencies are grouped
separately.

## Why cost looks like this

Auto Harness is built to run coding agents on **vendor subscription plans** (ChatGPT/Codex Plus–style seats, Claude Pro/Team CLI access, etc.)—**not** as a first-class **API / pay-per-token** agent platform.

| Intent                              | Implication                                                                                                                                                                                                                                                                                    |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Subscriptions, not API metering** | Marginal model cost is mostly **seat + plan quota**, already budgeted for humans, reused for automation. You are not designed around `$/1M tokens` as the control variable.                                                                                                                    |
| **Native CLI, no intermediary SDK** | Auto Harness drives each vendor's own CLI directly in **non-interactive mode**—not an Agent SDK or a universal harness wrapping it. That interface is what every vendor ships and supports for unattended use, independent of whatever a given SDK's subscription licensing allows this month. |
| **Harness AWS bill stays tiny**     | Coordination (API, queue, logs) should stay **dollars**, so the cost conversation stays on **plan seats, quota, and VPS size**—not Lambda.                                                                                                                                                     |

Deep “why product”: [why.md](why.md).

### Subscription vs API (cost model)

| Model                                 | How you pay                                     | Fits Auto Harness?                                                                                                                                                                          |
| ------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Subscription / seat + plan limits** | Monthly seat; rate/usage limits inside the plan | **Primary design.** Sessions burn plan quota via the installed CLI logged into that plan on the VPS.                                                                                        |
| **API keys (pay-per-token)**          | Metered by tokens/requests                      | Optional if a CLI is configured that way; **not** the economic rationale for the system. Infrastructure estimates below assume you are **not** modeling API spend as the main AI line item. |

**Usage limits** on subscriptions show up as CLI errors (parsed as `usage_limit`) rather than an AWS invoice spike—see [host-daemon.md — Usage limits](host-daemon.md#usage-limits-ai-vendor--cli-quotas).

### Non-interactive CLI (required by this cost path)

Because this is the interface every vendor actually ships and supports for unattended use:

1. Install the vendor **CLI** on the agent host and authenticate under the **subscription** account/profile.
2. Sessions invoke that CLI in **non-interactive** form (e.g. print/quiet flags, prompt as argv).
   The assigned CLI runner captures a merged PTY stream so tools that require a TTY can still use
   their non-interactive command modes.
3. Auto Harness never calls a vendor Agent SDK over the public API as the default integration.

That is a **product constraint**, not an implementation preference: it is how you attach factory automation to subscription capacity.

## Overview

Auto Harness AWS infrastructure is designed to be nearly free to operate. The control plane is serverless (API Gateway, Lambda, DynamoDB on-demand) and idle cost is designed to sit near zero. Costs scale with usage but stay negligible next to **subscription seats**, **plan quotas**, and **host** capacity. The control plane should not be the line item you worry about. Hosts do not autoscale to zero — that is the point of the queue.

**Modelled AWS coordination floor at the reference workload: ~$1/month** with S3 gzip
parts and **upload off by default** (~$0.60 keepalive-only). The legacy path that wrote every
log chunk through WebSocket + DynamoDB was ~$155; do not use that table for budgeting. Details
under [Modelled monthly AWS subtotal](#modelled-monthly-aws-subtotal).
Seats and the VPS are extra and dominate.

## AWS cost model (measured implementation + modelled workload)

The AWS runtime has been deployed and account-tested — see the Maturity table in
[deploy-aws.md](deploy-aws.md#maturity). Implementation constants that drive
volume are measured from the running code (20s WebSocket keepalive, 1-minute
EventBridge repair sweep, host gzip-part flush default 60s when upload is on).
Log **bodies** go to S3, not DynamoDB. Constants live in
`modules/shared/src/capacity-model.ts` and `session-log-settings.ts`.

The 2026-08-18 `qa` purge in `us-west-2` completed 3 short programmatic sessions
and later emptied 3 archived object versions. That run is acceptance evidence for
archive upload, not a monthly invoice. Monthly figures below use the reference
workload (100 sessions/day, 15-minute CLI at the measured 10 msg/s, 2 hosts + 2
viewers, 10 schedules, 256 KiB archive/session). They are a capacity model, not a contract
price.

Unit prices are illustrative inputs, not pinned contract terms; verify the current AWS pricing
pages for the deployment region before approving a budget.

| Service                   | Base input                                   | Workload-sensitive input                                |
| ------------------------- | -------------------------------------------- | ------------------------------------------------------- |
| **Lambda**                | Memory and duration per handler              | REST + inbound host WS (no log bodies)                  |
| **API Gateway REST**      | API calls made by clients                    | Session/UI polling pattern                              |
| **API Gateway WebSocket** | Connected-agent/viewer minutes and keepalive | Assign/ack/status, optional `session:log-part` notifies |
| **DynamoDB on-demand**    | Session/status/catalog operations            | No log bodies                                           |
| **DynamoDB storage**      | Durable catalog/session rows                 | Archive pointer rows only                               |
| **S3**                    | Gzip parts + final `logs.jsonl.gz`           | Host PUT when upload is on                              |
| **EventBridge (target)**  | Cron evaluation frequency                    | Number of schedules                                     |
| **CloudWatch (target)**   | Runtime log retention                        | Actual emitted runtime-log bytes                        |

## Reference workload (modelled from measured rates)

| Input                   | Reference value | Source                                                                                      |
| ----------------------- | --------------- | ------------------------------------------------------------------------------------------- |
| Sessions / day          | 100             | planning default                                                                            |
| Session duration        | 15 minutes      | long-running CLI, not a smoke `claude -p`                                                   |
| Daemon PTY coalesce     | 10 messages/s   | Host-pane live stream only; not sent on control-plane WS                                    |
| S3 part flush           | 60 s            | `DEFAULT_SESSION_LOG_SETTINGS.batchMaxWaitMs` when upload is on                             |
| Upload mode             | `off`           | Autonomous default; `subscribed` or `always` to write S3 parts                              |
| Hosts + viewers         | 2 + 2           | keepalive + connection minutes                                                              |
| Keepalive               | 20 s            | daemon `startDaemon`; each inbound frame is answered with one outbound `host:keepalive-ack` |
| Scheduler               | 1 / minute      | EventBridge / local repair sweep                                                            |
| Schedules               | 10              | every durable schedule is evaluated by each repair sweep                                    |
| Archive bytes / session | 256 KiB gzip    | Final `logs.jsonl.gz` when upload is on                                                     |

`estimateMonthlyCapacity(REFERENCE_WORKLOAD)` (upload **off**): Dynamo log writes **0**, S3 log
parts **0**. Keepalive + assign/ack/status + 43,200 cron invokes remain.

With `{ sessionLogUpload: true }` (1-minute parts): **45,000** part PUTs + **3,000** final PUTs
per month. Queue throughput is 100 assigns/day plus the one-minute repair sweep.

### Modelled monthly AWS subtotal

Premature: no invoice. Log **bodies** are S3 gzip parts (host PUT), not DynamoDB and not API
Gateway WS frames. Lambda **duration** omitted.

**Upload off (default)**

| Line                                        | Arithmetic           | Modelled $/month |
| ------------------------------------------- | -------------------- | ---------------- |
| Lambda (keepalive + session control + cron) | ~0.3M × $0.20 / 1M   | $0.06            |
| API Gateway REST                            | 30K × $3.50 / 1M     | $0.11            |
| API Gateway WebSocket messages              | ~0.52M × $1.00 / 1M  | $0.52            |
| API Gateway WebSocket connection-minutes    | 172,800 × $0.25 / 1M | $0.04            |
| DynamoDB log writes                         | 0                    | $0               |
| **Coordination floor**                      |                      | **~$0.70**       |

**Upload on, 1-minute gzip parts**

| Line                                             | Arithmetic                  | Modelled $/month |
| ------------------------------------------------ | --------------------------- | ---------------- |
| Rows above                                       | keepalive path unchanged    | ~$0.70           |
| S3 PUT parts                                     | 45,000 × $0.005 / 1K        | $0.23            |
| S3 PUT finals                                    | 3,000 × $0.005 / 1K         | $0.02            |
| S3 storage                                       | ~150 MiB gzip × $0.023 / GB | $0.00            |
| Optional `session:log-part` notifies (2 viewers) | 90,000 × $1.00 / 1M         | $0.09            |
| **Floor with upload**                            |                             | **~$1**          |

Both are **well under $10**. The retired SessionLogs path (~27M transact writes + ~81M WS
messages ≈ **~$155**) is not the budget. Vendor seats and the VPS dominate — see
[The real cost](#the-real-cost-subscriptions--hosts-not-api-tokens).

Unit prices are illustrative; verify current regional AWS pricing before budgeting.

## Cost by Component

### Lambda

In the target runtime, each API request or inbound WebSocket message triggers an invocation.
Viewer fanout is an outbound WebSocket delivery and does not invoke the Lambda. Hosts do not poll
for work; the 1-minute EventBridge rule is a repair sweep — see
[architecture/communication.md](architecture/communication.md). Duration and
memory must be measured after deployment.

- **Invocation cost**: $0.20 per 1M requests
- **Duration cost**: $0.0000166 per GB-second
- Multiply the measured request/message count by the measured duration and configured memory; do
  not assume a fixed 200 ms handler time.

### API Gateway

Two API types with separate pricing:

**REST API:**

- $3.50 per million requests
- A session creation + a few status checks + log fetches = ~10 REST calls per session
- 100 sessions/day × 10 calls × 30 days = 30K requests = **$0.11**

**WebSocket API:**

- $0.25 per million connection minutes
- $1.00 per million messages
- Each agent maintains 1 persistent connection (~43,000 minutes/month)
- Messages include keepalives, assign/ack/status, optional `session:log-part` notifies, and
  reconnect traffic. Log **bodies** are not WebSocket messages.

### DynamoDB

On-demand pricing — you pay per read/write with zero capacity planning.

- **Writes**: $1.25 per million write request units
- **Reads**: $0.25 per million read request units
- **Storage**: $0.25 per GB/month

Per session, approximate DynamoDB operations:

- Create session: 1 write
- Status updates (queued → running → completed): 3 writes
- Log entries: **none** in DynamoDB. Gzip parts go to S3 when upload is on.
- Scheduler queries: ~5 reads
- UI/API reads: ~10 reads

Catalog/session reads are unmodelled.

#### Session log cost control

Log bodies are **not** DynamoDB items. Host PUT of gzip parts (default **off**) plus a final
`logs.jsonl.gz` is the write path. Do not reintroduce per-chunk `SessionLogs` transact writes.
`Archives` metadata stays as pointer/`versionId`/retry only.

**Mitigation (this architecture):**

| Strategy                   | Impact                                                                   |
| -------------------------- | ------------------------------------------------------------------------ |
| Upload default `off`       | Autonomous runs generate no S3 log traffic                               |
| 1-minute gzip parts        | Tens of thousands of PUTs/month, not tens of millions of WS/Dynamo items |
| Fan-out only if subscribed | No per-line viewer copies                                                |
| Host-pane live stream      | PTY quality without control-plane ingest                                 |

Do not use the retired SessionLogs ~$155 table or the former ~50-chunk assumptions for capacity
planning. See the modelled subtotal above.

### S3

This section models the S3 archive without account-backed measurements. The synthesized foundation
creates an archive bucket and lifecycle policy; runtime code uploads gzip JSONL
(`logs.jsonl.gz` plus optional parts) when `ARCHIVE_BUCKET` is configured and retains bounded
metadata rows in the DynamoDB Archives table.

- **Storage**: $0.023 per GB/month (Standard), $0.0125 (Infrequent Access), $0.004 (Glacier)
- **Requests**: $0.005 per 1K PUT, $0.0004 per 1K GET

The target lifecycle policy moves objects to Infrequent Access after 30 days and Glacier after 90
days. Estimate storage only from measured archive bytes and expected retention; the former 50 KB
per-session assumption is unsupported.

### CloudWatch

- **Events**: The 1-minute cron trigger for schedule evaluation is included free
- **Logs**: Lambda runtime output is ingested by CloudWatch; measure emitted bytes rather than
  assuming 1 GB/month
- **Tip**: Set log retention to 7–14 days to avoid storage accumulation

## AWS Free Tier

Free-tier terms vary by account age, service, and current AWS policy. Verify the applicable terms,
then compare them with the measured inputs above. The repository has no evidence for a current
"covered" total.

## VPS Costs

The VPS running the auto harness agent is a separate cost. This depends on your provider and the workload:

| Provider     | Tier      | vCPU | RAM  | Cost                               |
| ------------ | --------- | ---- | ---- | ---------------------------------- |
| Hetzner      | CX22      | 2    | 4 GB | ~€4.35/month (2026)                |
| Hetzner      | CPX22     | 3    | 4 GB | ~€7.99/month (2026, up from €5.99) |
| DigitalOcean | Basic     | 2    | 4 GB | ~$24/month                         |
| AWS EC2      | t4g.small | 2    | 2 GB | ~$12.26/month (ARM, on-demand)     |
| AWS EC2      | t3.medium | 2    | 4 GB | ~$30/month                         |
| Self-hosted  | —         | —    | —    | Electricity                        |

Prices above are unmetered-hours quotes as of 2026-09; verify current pricing before budgeting—these
are illustrative inputs, not contract terms, same as the AWS unit prices elsewhere on this page. AI
CLI tools (Codex, Claude Code) can be CPU and memory intensive. For running 2–4 concurrent sessions, a
**4 GB RAM / 2 vCPU** instance is a reasonable minimum.

An owned VPS bills unmetered hours regardless of utilization; a managed agent sandbox (Modal, E2B,
Daytona, Vercel Sandbox) bills per second the sandbox is alive. Whether that trade favors an owned
host depends entirely on utilization—see the break-even math in
[comparison.md](comparison.md#cost-comparison).

## The real cost: subscriptions + hosts (not API tokens)

Under the intended model, the dominant costs are **outside** the Auto Harness AWS bill:

| Line item                | What you pay                                    | Notes                                                                                                                                                                       |
| ------------------------ | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Vendor subscriptions** | Seats / team plans for Codex, Claude Code, etc. | Shared with interactive human use. Automation **consumes plan quota**, it does not invent a separate API SKU.                                                               |
| **Plan usage limits**    | Soft/hard caps, rate limits                     | Hit → `usage_limit`; pause that Provider Account globally for its configurable cooldown (5h default), then use account/fallback routing. Providerless commands are ungated. |
| **VPS / runner hosts**   | Fixed monthly instance cost                     | Where CLIs run; see table above. More worktrees ⇒ more RAM/CPU, not more AWS API cost.                                                                                      |
| **Auto Harness on AWS**  | Modelled from measured rates                    | Queue, API, keepalive; log bodies are S3 parts when upload is on (~$1). See the reference workload above.                                                                   |

### Why we do _not_ lead with API unit economics

| API-metered agent stack                  | Subscription + non-interactive CLI (this project) |
| ---------------------------------------- | ------------------------------------------------- |
| Cost ≈ tokens × price                    | Cost ≈ seats + quota fit + host size              |
| Agent SDK / HTTP APIs                    | Native CLI, non-interactive mode, no intermediary |
| Easy to explode invoice with concurrency | Concurrency capped by plan + hardware             |
| Good for pure programmatic agents        | Good for “we already pay for the tools” factories |

If you deliberately point a CLI at **API keys**, treat that as a separate budget (true pay-per-session variance). Default docs and capacity planning assume **subscription authentication on the agent host**.

**Target AWS infrastructure should be a rounding error next to seats and machines.** Verify that
goal with deployed measurements before presenting a dollar estimate.

For how this cost shape compares to a managed-sandbox platform, and to a Cloudflare Workers control
plane, see [comparison.md](comparison.md#cost-comparison).

## Cost Optimization Tips

### Plan / subscription

1. **Cap concurrency** — worktree count ≤ what the plan and host can sustain without constant `usage_limit` failures.
2. **Prefer scheduled off-peak** — if the plan is shared with humans, run heavy maintenance when seats are idle.
3. **One profile per automation identity** — dedicated CLI profile for harness so human interactive use is not mixed with factory sessions.
4. **Watch usage_limit rate** — repeated hits mean you need more seats or lower concurrency; cooldown/fallback routing handles temporary account exhaustion, not more Lambda.

### AWS + VPS

1. **Set log retention when deploying** — CloudWatch Logs can accumulate. Set 7–14 day retention.
2. **Keep the archive path configured** — Terminal logs upload as JSONL when `ARCHIVE_BUCKET` is
   set; TTL then expires DynamoDB log rows. Measure archive bytes from a real transcript before
   changing lifecycle class.
3. **Right-size Lambda** — 256 MB is sufficient for most handlers. Don't over-allocate.
4. **Monitor with Cost Explorer** — Set up a $10 billing alert to catch any surprises.
5. **Use reserved capacity** — If DynamoDB costs grow, switch from on-demand to provisioned with auto-scaling.
6. **Compress logs** — Gzip session logs before archiving to S3 to reduce storage by ~80%.
7. **Right-size the VPS** — pay for RAM that matches concurrent CLIs; idle oversize hosts dominate AWS.
