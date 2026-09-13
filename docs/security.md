# Security

Trust boundaries, transport, operational controls, and host hardening.
**Authentication, login, and agent binding:** [auth.md](auth.md). **Roles and
the permission matrix:** [roles.md](roles.md).

## Principles

1. **No secrets in the control plane.** The Auto Harness cloud service holds no repository credentials, SSH keys, or AI tool API keys. All credentials live on the VPS.
2. **No secrets in prompts.** Never pass secrets through the API or in session prompts. The prompt is stored in DynamoDB and visible in the UI.
3. **Trusted execution environment.** The VPS agent runs directly on a secure server — no Docker isolation wrapping the agent (D9). The AI agents themselves may use Docker for development work within repositories.
4. **Principle of least privilege.** Users and service accounts are scoped by named role and optionally by repository; daemon keys use the `agent` role plus `boundHostId` ([roles.md](roles.md)).

Child-session spawning is separately capability-gated (`sessions:spawn`). When a session is assigned,
the control plane may include a short-lived, attempt-scoped service-account credential for the CLI
to call `POST /sessions/:id/children`. It is not included in session detail/list responses, is never
written to prompts or logs, and is invalidated when the assignment leaves `running`. The child route
accepts only the assigned parent and a parent-scoped `spawnKey`; it cannot be used to author an
unrelated root session or bypass repository scope.

Repository catalog admission enforces this boundary by accepting only credential-free HTTPS or
SCP-style SSH Git remotes; embedded userinfo, query parameters, and fragments are rejected.

## Threat model (prompt influence)

Session **prompts are attacker-influenced input**: they may originate from issue comments, CI failure text, or other untrusted sources. Design consequences (see also [plan.md](plan.md) D1/D4/D7):

| Control                                                  | What it does                                                                                                                                                           |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Named Provider Account / Command only (D4)               | Operators cannot run arbitrary shell strings via the API — a session targets a catalog entry, resolved control-plane-side into fixed argv                              |
| Fine-grained GitHub token or App installation token (D7) | Compromised session write access is scoped to one repo’s contents/PRs/issues; App tokens expire with the clamped run                                                   |
| Agent-held credentials                                   | Control plane never becomes a second vault for git/AI secrets                                                                                                          |
| No control-plane “publisher”                             | Agent opens PRs/comments itself — trust the agent host, not a second hop                                                                                               |
| Parent-scoped child credential                           | A running session can request independent follow-up work without receiving a general session-write credential; the parent and repository scope are checked server-side |

This does **not** protect against a fully compromised agent host, a malicious Command definition in the catalog, or exfiltration through whatever the AI CLI can reach with its own credentials.
The per-assignment child credential is intentionally usable by the assigned CLI; a compromised
session process can therefore spawn bounded child work within that parent’s authorized repository
and route policy until the credential is invalidated.

### Optional host-side GitHub App credentials

When `HARNESS_GITHUB_APP_CONFIG` is configured, the daemon signs a short-lived JWT locally and
mints one installation token for each mapped session repository. The token is injected directly as
`GH_TOKEN` into that assigned CLI and the repository's terminal hook, which needs the same scoped
identity for the D3 failure-escalation flow. It is redacted from streamed output and errors, and
the session ends before its GitHub expiry. Before minting succeeds, early terminal-hook paths stay
scrubbed. Mapped sessions also use a fresh private empty `GH_CONFIG_DIR`, preventing an ordinary
hook from falling back to a stored `gh` login. This is not an OS boundary: a compromised session
running as the same user can unset that variable or read other same-user credential stores. That
remains the accepted risk documented below; selected-repository App installation limits its blast
radius. Git continues to use the existing SSH transport.

If a terminal hook is handed to a replacement daemon or deferred until after the original
assignment ends, recovery mints a fresh repository-scoped token, uses a new isolated `gh` config
directory, and bounds hook execution by both the handoff deadline and token expiry. A failed
credential mint does not fall back to the daemon's ambient GitHub credentials.

The App private key remains a host secret, but the daemon and its session CLIs run as the same OS
user. A compromised session can therefore read it; mode `0600` prevents other local users, not the
session itself. Mitigate this accepted risk by installing the App only on the repositories served by
that host. Do not install it organization-wide, put it in prompts, or move it to the control plane.

## Transport security

| Layer     | Protection                                               |
| --------- | -------------------------------------------------------- |
| REST API  | HTTPS enforced by API Gateway (TLS 1.2+)                 |
| WebSocket | WSS enforced by API Gateway (TLS 1.2+)                   |
| DynamoDB  | Encrypted at rest (AWS managed keys)                     |
| S3        | Encrypted at rest (SSE-S3), bucket policy denies non-TLS |

Archived terminal transcripts are downloaded directly from the private S3 bucket with a
five-minute presigned `GetObject` URL. The REST Lambda verifies the canonical object key, length,
content type, and cold-storage state before signing. Treat the URL as a short-lived bearer secret:
clients fetch it immediately before download, and neither the API nor UI persists or logs it.

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
with separate buckets for login, reads, mutations, scheduler calls, host
traffic, and unauthenticated public ingress. Defaults are login **10/minute**,
reads **300/minute**, mutations, scheduler, and public Slack ingress
**60/minute**, and host REST traffic **600/minute**. WebSocket host
traffic is limited independently to **100 messages/second per connection** so
keepalives and batched logs do not consume a REST actor's budget. Health checks
are intentionally exempt.

The local listener accepts these environment overrides (all values are positive
integers): `HARNESS_RATE_LIMIT_WINDOW_SECONDS`,
`HARNESS_RATE_LIMIT_LOGIN`, `HARNESS_RATE_LIMIT_READ`,
`HARNESS_RATE_LIMIT_MUTATION`, `HARNESS_RATE_LIMIT_SCHEDULER`,
`HARNESS_RATE_LIMIT_HOST`, `HARNESS_RATE_LIMIT_PUBLIC_INGRESS`,
`HARNESS_RATE_LIMIT_MAX_ENTRIES`, and
`HARNESS_WS_RATE_LIMIT_PER_SECOND`. Set `HARNESS_RATE_LIMIT_MODE=disabled` only
for an isolated loopback test. The login bucket applies to `POST /auth/login`
and to unauthenticated requests that fail credential checks. It is keyed by
the peer socket address. Authenticated requests use only the actor
read/mutation/scheduler/host buckets. Public Slack callbacks and events use the
public-ingress bucket keyed by peer address before body parsing or storage. A
forwarded address is used only when
`HARNESS_TRUST_PROXY=true`; otherwise `X-Forwarded-For` is ignored because it
is spoofable. In the AWS deployment, the `/api/*` and `/health` CloudFront
behaviors add a generated origin-only credential that CloudFront overwrites if a
viewer sends the same header. API Gateway validates that credential with a
separate Lambda authorizer before the REST Lambda runs. Those behaviors also
forward CloudFront's generated `CloudFront-Viewer-Address` (viewer address and
source port); after the authorizer admits the request, the Lambda uses its IP as
the rate-limit key. A direct API Gateway caller cannot reach that Lambda or
choose a viewer address without the origin credential. The REST Lambda never
receives the credential through its environment, and CloudFront Function source
contains no credential. Local ingress has no authorizer and retains its explicit
proxy-trust behavior.

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

The Slack bot token, optional signing secret, and generic custom-webhook HMAC
secrets are the narrow exception to the control plane's usual no-secret rule.
They are encrypted with the KMS key named
by `KMS_KEY_ID` before they are stored in the Integrations table, and ciphertext
is bound to a stable integration-specific encryption context. Plaintext is never
retained in REST responses, logs, audit metadata, or durable records. If KMS is
unavailable, integration configuration writes fail closed. Repository, SSH, and AI
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

| Doc                              | Role                              |
| -------------------------------- | --------------------------------- |
| [auth.md](auth.md)               | Credentials, login, binding       |
| [roles.md](roles.md)             | Named roles and permission matrix |
| [api.md](api.md)                 | REST surface                      |
| [websocket.md](websocket.md)     | Connect tokens                    |
| [host-daemon.md](host-daemon.md) | Host-side agent behavior          |
| [setup.md](setup.md)             | Deploy secrets env vars           |
