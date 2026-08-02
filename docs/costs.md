# Cost Breakdown

## Overview

Auto-Harness is designed to be nearly free to operate. The AWS infrastructure costs scale linearly with usage but remain negligible for most teams. The real cost is the AI CLI tool API keys (OpenAI, Anthropic, etc.) running on your VPS — those are orders of magnitude higher than the Auto-Auto-Harness infrastructure bill.

## Estimated Monthly Costs

Based on **100 sessions/day, 2 connected agents, 1 developer using the UI**:

| Service | Usage | Unit Price | Monthly Cost |
|---------|-------|------------|-------------|
| **Lambda** | ~50K invocations, avg 200ms @ 256MB | $0.20/1M req + $0.0000166/GB-s | **~$0.15** |
| **API Gateway REST** | ~30K requests | $3.50/1M | **~$0.11** |
| **API Gateway WebSocket** | 2 agents × 43K conn-min + ~500K messages | $0.25/1M min + $1.00/1M msg | **~$0.52** |
| **DynamoDB on-demand** | ~200K writes + ~300K reads | $1.25/1M write, $0.25/1M read | **~$0.33** |
| **DynamoDB storage** | <1 GB (active data before archival) | $0.25/GB | **~$0.25** |
| **S3** | ~5 GB archived logs | $0.023/GB + minimal requests | **~$0.12** |
| **CloudWatch Events** | 1 cron trigger/min = 43K/month | Included | **$0.00** |
| **CloudWatch Logs** | Lambda logs, ~1 GB | $0.50/GB ingestion | **~$0.50** |
| | | **Total** | **~$2/month** |

## Scale Estimates

| Scale | Sessions/day | Agents | WebSocket Messages/mo | DynamoDB Writes/mo | Est. Monthly |
|-------|-------------|--------|----------------------|-------------------|-------------|
| Solo dev | 10 | 1 | ~100K | ~60K | **<$1** |
| Small team | 100 | 2–3 | ~500K | ~200K | **~$2** |
| Active team | 500 | 5 | ~2.5M | ~1M | **~$8** |
| Heavy use | 2,000 | 10 | ~10M | ~4M | **~$25** |
| Enterprise | 10,000 | 50 | ~50M | ~20M | **~$100** |

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

| Strategy | Impact |
|----------|--------|
| **Batching** | Agent buffers log chunks and writes via `BatchWriteItem` (up to 25 items per call). Reduces write API calls by ~25x. |
| **DynamoDB TTL** | Each log entry has a `ttl` attribute set to 7 days. DynamoDB auto-deletes expired entries at **no cost** — TTL deletions are free. |
| **S3 archival** | On session completion, logs are archived to S3 as a single `.jsonl` file. After archival, the DynamoDB entries are left to expire via TTL. |
| **Rate limiting** | The agent’s log streamer rate-limits WebSocket messages to avoid flooding (max 10 messages/second per session). |

**Cost comparison:**

| Approach | Writes/session | Monthly cost (100 sessions/day) |
|----------|----------------|--------------------------------|
| Naive (1 write per chunk) | ~500 | **$5.63** |
| Batched (25 per batch) | ~20 | **$0.23** |
| Batched + TTL (no manual delete) | ~20 writes, 0 deletes | **$0.23** |

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

For new AWS accounts, the first 12 months of free tier covers most of the Auto-Auto-Harness infrastructure:

| Service | Free Tier Allowance | Auto-Harness Usage (small team) | Covered? |
|---------|-------------------|---------------------------|----------|
| Lambda | 1M requests + 400K GB-s/month | ~50K requests | ✓ |
| DynamoDB | 25 GB storage + 25 WCU/RCU | <1 GB, on-demand | ✓ |
| S3 | 5 GB storage | <5 GB first year | ✓ |
| API Gateway REST | 1M calls/month (first 12 mo) | ~30K calls | ✓ |
| API Gateway WebSocket | Not included in free tier | ~500K messages | ✗ (~$0.50) |
| CloudWatch Logs | 5 GB ingestion | ~1 GB | ✓ |

**Effective cost with free tier: ~$0.50/month** (just the WebSocket messages).

## VPS Costs

The VPS running the Auto-Auto-Harness agent is a separate cost. This depends on your provider and the workload:

| Provider | Tier | vCPU | RAM | Cost |
|----------|------|------|-----|------|
| Hetzner | CPX21 | 3 | 4 GB | ~$7/month |
| DigitalOcean | Basic | 2 | 4 GB | ~$24/month |
| AWS EC2 | t3.medium | 2 | 4 GB | ~$30/month |
| Self-hosted | — | — | — | Electricity |

AI CLI tools (Codex, Claude Code) can be CPU and memory intensive. For running 2–4 concurrent sessions, a **4 GB RAM / 2 vCPU** instance is a reasonable minimum.

## The Real Cost: AI API Keys

The dominant cost is the AI tool usage, not Auto-Harness infrastructure:

| Tool | Approximate Cost per Session | 100 Sessions/day |
|------|------------------------------|-----------------|
| OpenAI Codex (GPT-4.1) | $0.50–$5.00 | $50–$500/month |
| Anthropic Claude Sonnet | $0.30–$3.00 | $30–$300/month |
| Anthropic Claude Opus | $1.00–$15.00 | $100–$1,500/month |

**Auto-Harness infrastructure (~$2/month) is <1% of your total AI automation spend.**

## Cost Optimization Tips

1. **Set log retention** — CloudWatch Logs can accumulate. Set 7–14 day retention.
2. **Archive aggressively** — Move completed session logs to S3 quickly, then to Glacier.
3. **Right-size Lambda** — 256 MB is sufficient for most handlers. Don't over-allocate.
4. **Monitor with Cost Explorer** — Set up a $10 billing alert to catch any surprises.
5. **Use reserved capacity** — If DynamoDB costs grow, switch from on-demand to provisioned with auto-scaling.
6. **Compress logs** — Gzip session logs before archiving to S3 to reduce storage by ~80%.
