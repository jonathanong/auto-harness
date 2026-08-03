# Security

Trust boundaries, transport, operational controls, and host hardening. **Authentication, roles, login, and agent binding:** [auth.md](auth.md).

## Principles

1. **No secrets in the control plane.** The Auto Harness cloud service holds no repository credentials, SSH keys, or AI tool API keys. All credentials live on the VPS.
2. **No secrets in prompts.** Never pass secrets through the API or in session prompts. The prompt is stored in DynamoDB and visible in the UI.
3. **Trusted execution environment.** The VPS agent runs directly on a secure server — no Docker isolation wrapping the agent (D9). The AI agents themselves may use Docker for development work within repositories.
4. **Principle of least privilege.** Service accounts are scoped by role and optionally by repository ([auth.md](auth.md#roles)).

## Threat model (prompt influence)

Session **prompts are attacker-influenced input**: they may originate from issue comments, CI failure text, or other untrusted sources. Design consequences (see also [plan.md](plan.md) D1/D4/D7):

| Control                          | What it does                                                                 |
| -------------------------------- | ---------------------------------------------------------------------------- |
| Named `commandProfile` only (D4) | Operators cannot run arbitrary shell strings via the API                     |
| Fine-grained GitHub token (D7)   | Compromised session write access is scoped to one repo’s contents/PRs/issues |
| Agent-held credentials           | Control plane never becomes a second vault for git/AI secrets                |
| No control-plane “publisher”     | Agent opens PRs/comments itself — trust the agent host, not a second hop     |

This does **not** protect against a fully compromised agent host, a malicious profile definition on that host, or exfiltration through whatever the AI CLI can reach with its own credentials.

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

| Endpoint           | Limit                                   |
| ------------------ | --------------------------------------- |
| `POST /sessions`   | 60 requests/minute per service account  |
| `GET` endpoints    | 300 requests/minute per service account |
| WebSocket messages | 100 messages/second per connection      |

Rate limit headers are returned on all REST responses:

- `X-RateLimit-Limit`
- `X-RateLimit-Remaining`
- `X-RateLimit-Reset`

## Audit logging

All mutating operations are logged in DynamoDB:

| Field        | Description                             |
| ------------ | --------------------------------------- |
| `timestamp`  | ISO 8601 timestamp                      |
| `userId`     | Service account or admin ID             |
| `action`     | e.g. `session:create`, `account:delete` |
| `resourceId` | ID of the affected resource             |
| `metadata`   | Additional context (IP, user agent)     |

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

| Doc                          | Role                               |
| ---------------------------- | ---------------------------------- |
| [auth.md](auth.md)           | Credentials, roles, login, binding |
| [api.md](api.md)             | REST surface                       |
| [websocket.md](websocket.md) | Connect tokens                     |
| [agent.md](agent.md)         | Host-side agent behavior           |
| [setup.md](setup.md)         | Deploy secrets env vars            |
