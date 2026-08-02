# Cost Breakdown

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

**Usage limits** on subscriptions show up as CLI errors (parsed as `usage_limit`) rather than an AWS invoice spike—see [agent.md — Usage limits](agent.md#usage-limits-ai-vendor--cli-quotas).

### Non-interactive CLI (required by this cost path)

Because subscriptions do not support Agent SDKs for this automation path:

1. Install the vendor **CLI** on the agent host and authenticate under the **subscription** account/profile.
2. Sessions invoke that CLI in **non-interactive** form (e.g. print/quiet flags, prompt as argv)—with a PTY when the tool still expects a TTY.
3. Auto Harness never calls a vendor Agent SDK over the public API as the default integration.

That is a **product constraint**, not an implementation preference: it is how you attach factory automation to subscription capacity.

## Overview

Auto Harness AWS infrastructure is designed to be nearly free to operate. Costs scale with usage but stay negligible next to **subscription seats**, **plan quotas**, and **VPS** capacity. The control plane should not be the line item you worry about.

## Estimated Monthly Costs (AWS only)

Based on **100 sessions/day, 2 connected agents, 1 developer using the UI**:

| Service                   | Usage                                    | Unit Price                     | Monthly Cost  |
| ------------------------- | ---------------------------------------- | ------------------------------ | ------------- |
| **Lambda**                | ~50K invocations, avg 200ms @ 256MB      | $0.20/1M req + $0.0000166/GB-s | **~$0.15**    |
| **API Gateway REST**      | ~30K requests                            | $3.50/1M                       | **~$0.11**    |
| **API Gateway WebSocket** | 2 agents × 43K conn-min + ~500K messages | $0.25/1M min + $1.00/1M msg    | **~$0.52**    |
| **DynamoDB on-demand**    | ~200K writes + ~300K reads               | $1.25/1M write, $0.25/1M read  | **~$0.33**    |
| **DynamoDB storage**      | <1 GB (active data before archival)      | $0.25/GB                       | **~$0.25**    |
| **S3**                    | ~5 GB archived logs                      | $0.023/GB + minimal requests   | **~$0.12**    |
| **CloudWatch Events**     | 1 cron trigger/min = 43K/month           | Included                       | **$0.00**     |
| **CloudWatch Logs**       | Lambda logs, ~1 GB                       | $0.50/GB ingestion             | **~$0.50**    |
|                           |                                          | **Total**                      | **~$2/month** |

## Scale Estimates

| Scale       | Sessions/day | Agents | WebSocket Messages/mo | DynamoDB Writes/mo | Est. Monthly |
| ----------- | ------------ | ------ | --------------------- | ------------------ | ------------ |
| Solo dev    | 10           | 1      | ~100K                 | ~60K               | **<$1**      |
| Small team  | 100          | 2–3    | ~500K                 | ~200K              | **~$2**      |
| Active team | 500          | 5      | ~2.5M                 | ~1M                | **~$8**      |
| Heavy use   | 2,000        | 10     | ~10M                  | ~4M                | **~$25**     |
| Enterprise  | 10,000       | 50     | ~50M                  | ~20M               | **~$100**    |

## Cost by Component

### Lambda

Lambda is the cheapest component. Each API request or WebSocket message triggers a short invocation (~200ms).

- **Invocation cost**: $0.20 per 1M requests
- **Duration cost**: $0.0000166 per GB-second
- A typical invocation (256MB, 200ms) costs **$0.0000008** — less than a millionth of a dollar

At 100 sessions/day, Lambda costs are under $0.20/month.

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
- Messages: pings every 30s (~86K/agent/month) + log chunks (~50 per session × 3K sessions/month = 150K) + status updates
- Total: **~$0.52**

### DynamoDB

On-demand pricing — you pay per read/write with zero capacity planning.

- **Writes**: $1.25 per million write request units
- **Reads**: $0.25 per million read request units
- **Storage**: $0.25 per GB/month

Per session, approximate DynamoDB operations:

- Create session: 1 write
- Status updates (queued → running → completed): 3 writes
- Log entries: ~50 writes (batched via `BatchWriteItem`)
- Scheduler queries: ~5 reads
- UI/API reads: ~10 reads

At 100 sessions/day: ~200K writes + ~300K reads = **~$0.33**

#### SessionLogs Cost Control

SessionLogs is the highest-volume table. A chatty AI agent can produce hundreds of stdout chunks per session. Without mitigation, this is the most expensive DynamoDB component.

**Mitigation strategies (all implemented):**

| Strategy          | Impact                                                                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **Batching**      | Agent buffers log chunks and writes via `BatchWriteItem` (up to 25 items per call). Reduces write API calls by ~25x.                       |
| **DynamoDB TTL**  | Each log entry has a `ttl` attribute set to 7 days. DynamoDB auto-deletes expired entries at **no cost** — TTL deletions are free.         |
| **S3 archival**   | On session completion, logs are archived to S3 as a single `.jsonl` file. After archival, the DynamoDB entries are left to expire via TTL. |
| **Rate limiting** | The agent’s log streamer rate-limits WebSocket messages to avoid flooding (max 10 messages/second per session).                            |

**Cost comparison:**

| Approach                         | Writes/session        | Monthly cost (100 sessions/day) |
| -------------------------------- | --------------------- | ------------------------------- |
| Naive (1 write per chunk)        | ~500                  | **$5.63**                       |
| Batched (25 per batch)           | ~20                   | **$0.23**                       |
| Batched + TTL (no manual delete) | ~20 writes, 0 deletes | **$0.23**                       |

With batching and TTL, SessionLogs adds roughly **$0.23/month** at 100 sessions/day. Storage stays under 500 MB because TTL auto-deletes after 7 days.

### S3

Archived session logs are cheap to store.

- **Storage**: $0.023 per GB/month (Standard), $0.0125 (Infrequent Access), $0.004 (Glacier)
- **Requests**: $0.005 per 1K PUT, $0.0004 per 1K GET

With lifecycle policies:

- Logs move to Infrequent Access after 30 days
- Logs move to Glacier after 90 days
- Assuming ~50 KB per session log, 3K sessions/month = ~150 MB/month of new data
- After a year: ~1.8 GB, mostly in Glacier = **pennies**

### CloudWatch

- **Events**: The 1-minute cron trigger for schedule evaluation is included free
- **Logs**: Lambda automatically logs to CloudWatch. At $0.50/GB ingestion, typical usage generates ~1 GB/month = **$0.50**
- **Tip**: Set log retention to 7–14 days to avoid storage accumulation

## AWS Free Tier

For new AWS accounts, the first 12 months of free tier covers most of the auto harness infrastructure:

| Service               | Free Tier Allowance           | Auto-Harness Usage (small team) | Covered?   |
| --------------------- | ----------------------------- | ------------------------------- | ---------- |
| Lambda                | 1M requests + 400K GB-s/month | ~50K requests                   | ✓          |
| DynamoDB              | 25 GB storage + 25 WCU/RCU    | <1 GB, on-demand                | ✓          |
| S3                    | 5 GB storage                  | <5 GB first year                | ✓          |
| API Gateway REST      | 1M calls/month (first 12 mo)  | ~30K calls                      | ✓          |
| API Gateway WebSocket | Not included in free tier     | ~500K messages                  | ✗ (~$0.50) |
| CloudWatch Logs       | 5 GB ingestion                | ~1 GB                           | ✓          |

**Effective cost with free tier: ~$0.50/month** (just the WebSocket messages).

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

| Line item                | What you pay                                    | Notes                                                                                                         |
| ------------------------ | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Vendor subscriptions** | Seats / team plans for Codex, Claude Code, etc. | Shared with interactive human use. Automation **consumes plan quota**, it does not invent a separate API SKU. |
| **Plan usage limits**    | Soft/hard caps, rate limits                     | Hit → session `usage_limit` (see agent docs). Size concurrency (worktrees) to stay inside the plan.           |
| **VPS / runner hosts**   | Fixed monthly instance cost                     | Where CLIs run; see table above. More worktrees ⇒ more RAM/CPU, not more AWS API cost.                        |
| **Auto Harness on AWS**  | ~$1–$25/mo for most teams                       | Queue, API, logs only.                                                                                        |

### Why we do _not_ lead with API unit economics

| API-metered agent stack                  | Subscription + non-interactive CLI (this project) |
| ---------------------------------------- | ------------------------------------------------- |
| Cost ≈ tokens × price                    | Cost ≈ seats + quota fit + host size              |
| Agent SDK / HTTP APIs                    | CLI non-interactive mode only                     |
| Easy to explode invoice with concurrency | Concurrency capped by plan + hardware             |
| Good for pure programmatic agents        | Good for “we already pay for the tools” factories |

If you deliberately point a CLI at **API keys**, treat that as a separate budget (true pay-per-session variance). Default docs and capacity planning assume **subscription authentication on the agent host**.

**AWS infrastructure (~$2/month at small-team scale) should be a rounding error next to seats and machines.**

## Cost Optimization Tips

### Plan / subscription

1. **Cap concurrency** — worktree count ≤ what the plan and host can sustain without constant `usage_limit` failures.
2. **Prefer scheduled off-peak** — if the plan is shared with humans, run heavy maintenance when seats are idle.
3. **One profile per automation identity** — dedicated CLI profile for harness so human interactive use is not mixed with factory sessions.
4. **Watch usage_limit rate** — repeated hits mean you need more seats, lower concurrency, or deferred retry policy—not more Lambda.

### AWS + VPS

1. **Set log retention** — CloudWatch Logs can accumulate. Set 7–14 day retention.
2. **Archive aggressively** — Move completed session logs to S3 quickly, then to Glacier.
3. **Right-size Lambda** — 256 MB is sufficient for most handlers. Don't over-allocate.
4. **Monitor with Cost Explorer** — Set up a $10 billing alert to catch any surprises.
5. **Use reserved capacity** — If DynamoDB costs grow, switch from on-demand to provisioned with auto-scaling.
6. **Compress logs** — Gzip session logs before archiving to S3 to reduce storage by ~80%.
7. **Right-size the VPS** — pay for RAM that matches concurrent CLIs; idle oversize hosts dominate AWS.
