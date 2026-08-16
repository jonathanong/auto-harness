# Security

Trust boundaries, transport, operational controls, and host hardening. **Authentication, roles, login, and agent binding:** [auth.md](auth.md).

## Principles

1. **No secrets in the control plane.** The Auto Harness cloud service holds no repository credentials, SSH keys, or AI tool API keys. All credentials live on the VPS.
2. **No secrets in prompts.** Never pass secrets through the API or in session prompts. The prompt is stored in DynamoDB and visible in the UI.
3. **Trusted execution environment.** The VPS agent runs directly on a secure server — no Docker isolation wrapping the agent (D9). The AI agents themselves may use Docker for development work within repositories.
4. **Principle of least privilege.** Service accounts are scoped by role and optionally by repository ([auth.md](auth.md#roles)).

## Threat model (prompt influence)

Session **prompts are attacker-influenced input**: they may originate from issue comments, CI failure text, or other untrusted sources. Design consequences (see also [plan.md](plan.md) D1/D4/D7):

| Control                                    | What it does                                                                                                                              |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Named Provider Account / Command only (D4) | Operators cannot run arbitrary shell strings via the API — a session targets a catalog entry, resolved control-plane-side into fixed argv |
| Fine-grained GitHub token (D7)             | Compromised session write access is scoped to one repo’s contents/PRs/issues                                                              |
| Agent-held credentials                     | Control plane never becomes a second vault for git/AI secrets                                                                             |
| No control-plane “publisher”               | Agent opens PRs/comments itself — trust the agent host, not a second hop                                                                  |

This does **not** protect against a fully compromised agent host, a malicious Command definition in the catalog, or exfiltration through whatever the AI CLI can reach with its own credentials.

## Transport security

| Layer     | Protection                                               |
| --------- | -------------------------------------------------------- |
| REST API  | HTTPS enforced by API Gateway (TLS 1.2+)                 |
| WebSocket | WSS enforced by API Gateway (TLS 1.2+)                   |
| DynamoDB  | Encrypted at rest (AWS managed keys)                     |
| S3        | Encrypted at rest (SSE-S3), bucket policy denies non-TLS |

## CORS policy

The Web UI domain is the only allowed origin for browser requests. Configure via CDK:

```typescript
cors: {
  allowOrigins: ['https://auto-harness.yourdomain.com'],
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowHeaders: ['Authorization', 'Content-Type'],
}
```

## Rate limiting

REST uses fixed-window limits keyed by the authenticated actor (`kind:id`),
with separate buckets for login, reads, mutations, scheduler calls, and host
traffic. Defaults are login **10/minute**, reads **300/minute**, mutations and
scheduler **60/minute**, and host REST traffic **600/minute**. WebSocket host
traffic is limited independently to **100 messages/second per connection** so
keepalives and batched logs do not consume a REST actor's budget. Health checks
are intentionally exempt.

The local listener accepts these environment overrides (all values are positive
integers): `HARNESS_RATE_LIMIT_WINDOW_SECONDS`,
`HARNESS_RATE_LIMIT_LOGIN`, `HARNESS_RATE_LIMIT_READ`,
`HARNESS_RATE_LIMIT_MUTATION`, `HARNESS_RATE_LIMIT_SCHEDULER`,
`HARNESS_RATE_LIMIT_HOST`, `HARNESS_RATE_LIMIT_MAX_ENTRIES`, and
`HARNESS_WS_RATE_LIMIT_PER_SECOND`. Set `HARNESS_RATE_LIMIT_MODE=disabled` only
for an isolated loopback test. The login bucket applies to `POST /auth/login`
and to unauthenticated requests that fail credential checks. It is keyed by
the peer socket address. Authenticated requests use only the actor
read/mutation/scheduler/host buckets. A forwarded address is used only when
`HARNESS_TRUST_PROXY=true`; otherwise `X-Forwarded-For` is ignored because it
is spoofable.

In memory-only mode, counters are bounded by `HARNESS_RATE_LIMIT_MAX_ENTRIES`
and evict the oldest key when full. With DynamoDB-backed mode, each counter is
an atomic conditional update in the `RateLimits` table with TTL cleanup, so
multiple API workers share the same budget. Durable failures fail closed by
default (`HARNESS_RATE_LIMIT_FAIL_MODE=closed`); `open` is an explicit
availability tradeoff for development and emits an error metric event. A
closed durable failure returns `503 RATE_LIMIT_UNAVAILABLE`; an exhausted
budget returns standards-compatible `429 RATE_LIMITED`, `Retry-After` seconds,
and `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and epoch-second
`X-RateLimit-Reset` headers.

Applications may provide `onRateLimitEvent` when constructing the local server
to connect metrics/logging. Events include only a hashed actor key, bucket,
limit, outcome, and reset data. Denied mutations append a bounded
`rate-limit:deny` audit event containing the route and bucket, never request
bodies, credentials, prompts, logs, or raw IP addresses. If that audit append
fails, the endpoint fails closed with `500` rather than returning an
unaudited denial.

Local ingress also rejects HTTP JSON bodies over 1 MiB, WebSocket frames over
128 KiB, and individual log chunks over 32 KiB. In-memory session log retention
is capped at 10,000 chunks / 10 MiB per session. A WebSocket host must
authenticate with a service-account key bound to its `hostId`; it can only ack,
log, or report status for sessions assigned to that host. Closing the socket
immediately disconnects and requeues its host connection.

Rate limit headers are returned on all REST responses:

- `X-RateLimit-Limit`
- `X-RateLimit-Remaining`
- `X-RateLimit-Reset`

## Audit logging

All authentication outcomes and mutating control-plane operations are recorded
in the append-only DynamoDB `AuditLogs` table. This includes REST management,
sessions, schedules, scheduler actions, host inventory/configuration, and
catalog changes. There is no update or delete API for audit records.

| Field             | Description                                                                |
| ----------------- | -------------------------------------------------------------------------- |
| `id`              | Immutable event identifier                                                 |
| `createdAt`       | ISO 8601 event time                                                        |
| `actor`           | Principal `id`, `kind`, and `role`; scheduler/cron uses the `system` actor |
| `action`          | e.g. `session:create`, `schedule:trigger`, `provider-account:delete`       |
| `resourceType/id` | Target object, rather than an inferred request URL                         |
| `repositoryId`    | Repository scope when the action has one                                   |
| `outcome`         | `success`, `denied`, or `failed`                                           |
| `metadata`        | Bounded flat operational fields only                                       |

Metadata is capped and drops values whose field names indicate passwords,
tokens, secrets, prompts, log content, cookies, authorization headers, or API
keys. Never pass request bodies or raw integration configuration to the audit
writer.

The control plane writes the audit event before acknowledging a durable
mutation. Existing state operations cannot all participate in a single DynamoDB
transaction, so an audit append failure causes a 500 response even if the
domain mutation was already committed. This fail-closed acknowledgement makes
the exceptional state observable and recoverable rather than silently reporting
an unaudited success.

## Integration secrets

The Slack bot token and optional signing secret are the narrow exception to the
control plane's usual no-secret rule. They are encrypted with the KMS key named
by `KMS_KEY_ID` before they are stored in the Integrations table, and ciphertext
is bound to a stable Slack-specific encryption context. Plaintext is never
retained in REST responses, logs, audit metadata, or durable records. If KMS is
unavailable, Slack configuration writes fail closed. Repository, SSH, and AI
provider credentials remain agent-held and are never accepted by this API.

## VPS hardening recommendations

The VPS runs AI agents with filesystem and network access. Harden it:

- **SSH:** Key-based authentication only. Disable password auth. Disable root login.
- **Firewall:** Allow inbound SSH (restricted to your IPs) only. The agent makes only outbound WebSocket connections.
- **User:** Run the agent as a dedicated non-root user (e.g. `harness`).
- **File permissions:** Worktree directories owned by the agent user. Restrict access to `.env` files (`chmod 600`).
- **Docker:** If installed for agent tool use, add the agent user to the `docker` group. Be aware this grants root-equivalent access on the host.
- **Updates:** Keep the OS, Node.js, git, and AI CLI tools up to date.
- **Monitoring:** Monitor disk usage (worktrees and logs can grow), CPU/memory (AI agents can be resource-intensive).
- **Secrets management:** Store AI tool API keys in `.env` files or environment variables on the VPS. Never commit them.

Agent identity on the wire uses a **bound** service account API key — see [auth.md — VPS agent authentication](auth.md#vps-agent-authentication).

## Security boundaries

```
┌──────────────────────────────────────────────────┐
│  Cloud (AWS)                                     │
│                                                  │
│  ✓ Admin accounts (Lambda env var, base64)       │
│  ✓ User password hashes (DynamoDB, bcrypt)        │
│  ✓ Service account key hashes (DynamoDB, SHA-256) │
│  ✓ Session cookies (signed JWT)                   │
│  ✓ Session data, logs, prompts                   │
│  ✗ NO repository credentials                     │
│  ✗ NO AI tool API keys                           │
│  ✗ NO secrets in prompts                         │
└───────────────────────┬──────────────────────────┘
                        │ WebSocket (TLS)
                        │ Authenticated via API key
┌───────────────────────▼──────────────────────────┐
│  VPS / Secure Server                             │
│                                                  │
│  ✓ SSH keys for git access                       │
│  ✓ AI tool API keys (.env / env vars)            │
│  ✓ Docker available for agent development use    │
│  ✓ Filesystem access to repositories             │
│  ✓ Agent service account API key                 │
└──────────────────────────────────────────────────┘
```

## Related

| Doc                              | Role                               |
| -------------------------------- | ---------------------------------- |
| [auth.md](auth.md)               | Credentials, roles, login, binding |
| [api.md](api.md)                 | REST surface                       |
| [websocket.md](websocket.md)     | Connect tokens                     |
| [host-daemon.md](host-daemon.md) | Host-side agent behavior           |
| [setup.md](setup.md)             | Deploy secrets env vars            |
