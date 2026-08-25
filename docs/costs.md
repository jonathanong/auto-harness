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

| Intent                              | Implication                                                                                                                                                                 |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Subscriptions, not API metering** | Marginal model cost is mostly **seat + plan quota**, already budgeted for humans, reused for automation. You are not designed around `$/1M tokens` as the control variable. |
| **No Agent SDK on those plans**     | Subscription products typically **do not** expose Agent SDKs / full programmatic agent APIs. Automation must drive the **CLI in non-interactive mode** instead.             |
| **Harness AWS bill stays tiny**     | Coordination (API, queue, logs) should stay **dollars**, so the cost conversation stays on **plan seats, quota, and VPS size**—not Lambda.                                  |

Deep “why product”: [why.md](why.md).

### Subscription vs API (cost model)

| Model                                 | How you pay                                     | Fits Auto Harness?                                                                                                                                                                          |
| ------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Subscription / seat + plan limits** | Monthly seat; rate/usage limits inside the plan | **Primary design.** Sessions burn plan quota via the installed CLI logged into that plan on the VPS.                                                                                        |
| **API keys (pay-per-token)**          | Metered by tokens/requests                      | Optional if a CLI is configured that way; **not** the economic rationale for the system. Infrastructure estimates below assume you are **not** modeling API spend as the main AI line item. |

**Usage limits** on subscriptions show up as CLI errors (parsed as `usage_limit`) rather than an AWS invoice spike—see [host-daemon.md — Usage limits](host-daemon.md#usage-limits-ai-vendor--cli-quotas).

### Non-interactive CLI (required by this cost path)

Because subscriptions do not support Agent SDKs for this automation path:

1. Install the vendor **CLI** on the agent host and authenticate under the **subscription** account/profile.
2. Sessions invoke that CLI in **non-interactive** form (e.g. print/quiet flags, prompt as argv).
   The assigned CLI runner captures a merged PTY stream so tools that require a TTY can still use
   their non-interactive command modes.
3. Auto Harness never calls a vendor Agent SDK over the public API as the default integration.

That is a **product constraint**, not an implementation preference: it is how you attach factory automation to subscription capacity.

## Overview

Auto Harness AWS infrastructure is designed to be nearly free to operate. Costs scale with usage but stay negligible next to **subscription seats**, **plan quotas**, and **VPS** capacity. The control plane should not be the line item you worry about.

## AWS cost model (measured implementation + modelled workload)

The AWS runtime has been deployed and account-tested — see the Maturity table in
[deploy-aws.md](deploy-aws.md#maturity). Implementation constants that drive
volume are measured from the running code (daemon ~10 log messages/s after
source-side coalesce, local 25-item connection-fence batches, 20s WebSocket
keepalive, 1-minute EventBridge scheduler, 7-day SessionLogs TTL, 32 KiB API
Gateway frame). Those constants live in `modules/shared/src/capacity-model.ts`.

The 2026-08-18 `qa` purge in `us-west-2` completed 3 short programmatic sessions
and later emptied 3 archived object versions. That run is acceptance evidence for
archive upload, not a monthly invoice. Monthly figures below use the reference
workload (100 sessions/day, 15-minute CLI at the measured 10 msg/s, 2 hosts + 2
viewers, 10 schedules, 256 KiB archive/session). They are a capacity model, not a contract
price.

Unit prices are illustrative inputs, not pinned contract terms; verify the current AWS pricing
pages for the deployment region before approving a budget.

| Service                   | Base input                                   | Workload-sensitive input                               |
| ------------------------- | -------------------------------------------- | ------------------------------------------------------ |
| **Lambda**                | Memory and duration per handler              | REST requests + inbound host WebSocket/log messages    |
| **API Gateway REST**      | API calls made by clients                    | Session/UI polling pattern                             |
| **API Gateway WebSocket** | Connected-agent/viewer minutes and keepalive | Log chunks, status messages, reconnects, subscriptions |
| **DynamoDB on-demand**    | Session/status/catalog operations            | One current write per log chunk + reads                |
| **DynamoDB storage**      | Durable catalog/session rows                 | Log retention and archive-row size                     |
| **S3 (target)**           | Archive PUT/GET count                        | Compressed archive bytes and lifecycle class           |
| **EventBridge (target)**  | Cron evaluation frequency                    | Number of schedules                                    |
| **CloudWatch (target)**   | Runtime log retention                        | Actual emitted runtime-log bytes                       |

## Reference workload (modelled from measured rates)

| Input                   | Reference value | Source                                                          |
| ----------------------- | --------------- | --------------------------------------------------------------- |
| Sessions / day          | 100             | planning default                                                |
| Session duration        | 15 minutes      | long-running CLI, not a smoke `claude -p`                       |
| Daemon log rate         | 10 messages/s   | `DEFAULT_LOG_MESSAGES_PER_SEC`                                  |
| Log chunks / session    | 9,000           | duration × log rate; capped at 10,000 retained chunks/session   |
| Retained log content    | at most 10 MiB  | session byte cap before ordinary CLI output is dropped          |
| Local log fence batch   | 25 items        | reduces local fence checks, not deployed item writes            |
| Hosts + viewers         | 2 + 2           | keepalive + connection minutes                                  |
| Keepalive               | 20 s            | daemon `startDaemon`                                            |
| Scheduler               | 1 / minute      | EventBridge / local repair sweep                                |
| Schedules               | 10              | every durable schedule is evaluated by each repair sweep        |
| Archive bytes / session | 256 KiB         | JSONL model; 3 objects were purged in `qa` without size metrics |
| SessionLogs TTL         | 7 days          | `ttl` on new writes                                             |

At that workload the model reports ~27M DynamoDB log item writes/month and ~27M
transactional write items/month, ~81M WebSocket messages/month (including each
viewer copy), ~27.4M Lambda invocations/month (viewer fanout is outbound and does
not invoke Lambda; the 43,200 scheduler sweeps do), 43,200 scheduler invocations and 432,000 schedule evaluations/month,
and ~750 MiB archive PUT volume/month. Queue throughput is 100 assigns/day plus
the one-minute repair sweep. Re-run `estimateMonthlyCapacity` when the session mix
changes; do not scale by session count alone.

## Cost by Component

### Lambda

In the target runtime, each API request or inbound WebSocket message triggers an invocation.
Viewer fanout is an outbound WebSocket delivery and does not invoke the Lambda. Duration and
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
- Messages include keepalives, every current log chunk, status updates, subscriptions, and
  reconnect traffic. Measure that total; the former 50-chunk/session assumption is invalid.

### DynamoDB

On-demand pricing — you pay per read/write with zero capacity planning.

- **Writes**: $1.25 per million write request units
- **Reads**: $0.25 per million read request units
- **Storage**: $0.25 per GB/month

Per session, approximate DynamoDB operations:

- Create session: 1 write
- Status updates (queued → running → completed): 3 writes
- Log entries: one item write and one transactional item per received chunk. Up to 25 adjacent
  local WebSocket chunks can share a connection-fence batch, which reduces local coordination but
  does not reduce deployed transactional item capacity; chunk count must be measured from the
  chosen CLI and workload.
- Scheduler queries: ~5 reads
- UI/API reads: ~10 reads

Do not aggregate these into a monthly DynamoDB figure until chunk counts and real read behavior
are measured.

#### SessionLogs Cost Control

SessionLogs is the highest-volume table. A chatty AI agent can produce hundreds of stdout chunks per session. Without mitigation, this is the most expensive DynamoDB component.

**Current implementation:** local WebSocket ingress coalesces up to 25 adjacent `session:log`
chunks behind one connection fence, flushing before any later control/status frame and before
disconnect. API Gateway still invokes the deployed handler for every received frame, and DynamoDB
charges one transactional item write per log chunk. Viewer subscriptions add one WebSocket delivery
per log chunk per connected viewer.
New SessionLogs writes set `ttl` to now + 7 days (Unix epoch seconds). Local table creation and
the synthesized AWS table both enable DynamoDB TTL on that attribute, so new rows expire without
application deletes. Rows written before this change omit `ttl` and are not backfilled (see
[aws.md#sessionlogs-retention-and-archival](aws.md#sessionlogs-retention-and-archival)). On
terminal status, the API serializes one
JSONL object, retains only bounded pointer/status metadata in DynamoDB, and uploads through the
configured private S3 adapter. A pending metadata row makes interrupted uploads retryable without
putting the body in DynamoDB. The archive path has been functionally exercised — a real purge run
against a real account emptied 3 archived object versions from the session archive bucket after 3
short test sessions completed — but no byte-size or cost measurements exist from that or any other
run. Consequently, the totals above and the optimized comparison below must be recalculated before
an AWS launch.

**Target mitigation strategies:**

| Strategy          | Impact                                                                                             |
| ----------------- | -------------------------------------------------------------------------------------------------- |
| **DynamoDB TTL**  | New writes carry `ttl` (7-day expiry); DynamoDB deletes expired items without application deletes. |
| **S3 archival**   | Upload completed logs to S3 as one archive object, then leave DynamoDB entries to expire via TTL.  |
| **Rate limiting** | Bound the agent's WebSocket log-message rate so a chatty CLI cannot flood the control plane.       |

**Cost comparison:**

| Approach                                       | Writes/session                         | Monthly cost (100 sessions/day) |
| ---------------------------------------------- | -------------------------------------- | ------------------------------- |
| Current fenced batching                        | workload-dependent transactional items | Not yet measured                |
| Example (500 chunks, full 25-item batches)     | 500 transactional items                | Recalculate before launch       |
| Target batching + TTL (no explicit log delete) | same item writes, 0 explicit deletes   | Recalculate before launch       |

Do not use the former ~50-chunk or $0.23/month assumptions for capacity planning. Measure a real
transcript, then account for actual item sizes, transactional pricing, retries, API Gateway
frames, and retention.

### S3

This section models the S3 archive without account-backed measurements. The synthesized foundation
creates an archive bucket and lifecycle policy; runtime code uploads terminal JSONL when
`ARCHIVE_BUCKET` is configured and retains bounded metadata rows in the DynamoDB Archives table.

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

| Provider     | Tier      | vCPU | RAM  | Cost        |
| ------------ | --------- | ---- | ---- | ----------- |
| Hetzner      | CPX21     | 3    | 4 GB | ~$7/month   |
| DigitalOcean | Basic     | 2    | 4 GB | ~$24/month  |
| AWS EC2      | t3.medium | 2    | 4 GB | ~$30/month  |
| Self-hosted  | —         | —    | —    | Electricity |

AI CLI tools (Codex, Claude Code) can be CPU and memory intensive. For running 2–4 concurrent sessions, a **4 GB RAM / 2 vCPU** instance is a reasonable minimum.

## The real cost: subscriptions + hosts (not API tokens)

Under the intended model, the dominant costs are **outside** the Auto Harness AWS bill:

| Line item                | What you pay                                    | Notes                                                                                                                                                                       |
| ------------------------ | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Vendor subscriptions** | Seats / team plans for Codex, Claude Code, etc. | Shared with interactive human use. Automation **consumes plan quota**, it does not invent a separate API SKU.                                                               |
| **Plan usage limits**    | Soft/hard caps, rate limits                     | Hit → `usage_limit`; pause that Provider Account globally for its configurable cooldown (5h default), then use account/fallback routing. Providerless commands are ungated. |
| **VPS / runner hosts**   | Fixed monthly instance cost                     | Where CLIs run; see table above. More worktrees ⇒ more RAM/CPU, not more AWS API cost.                                                                                      |
| **Auto Harness on AWS**  | Modelled from measured rates                    | Queue, API, and logs; log volume dominates. See the reference workload above.                                                                                               |

### Why we do _not_ lead with API unit economics

| API-metered agent stack                  | Subscription + non-interactive CLI (this project) |
| ---------------------------------------- | ------------------------------------------------- |
| Cost ≈ tokens × price                    | Cost ≈ seats + quota fit + host size              |
| Agent SDK / HTTP APIs                    | CLI non-interactive mode only                     |
| Easy to explode invoice with concurrency | Concurrency capped by plan + hardware             |
| Good for pure programmatic agents        | Good for “we already pay for the tools” factories |

If you deliberately point a CLI at **API keys**, treat that as a separate budget (true pay-per-session variance). Default docs and capacity planning assume **subscription authentication on the agent host**.

**Target AWS infrastructure should be a rounding error next to seats and machines.** Verify that
goal with deployed measurements before presenting a dollar estimate.

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
