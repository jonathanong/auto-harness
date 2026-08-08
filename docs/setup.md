# Setup

Install Auto Harness and run it in production-shaped environments. **Day-to-day local work (DynamoDB Local, `pnpm local:*`, e2e, manage UI) lives in [local-development.md](local-development.md).**

**Deploy / update / teardown:** [deploy.md](deploy.md) (index) · [deploy-local.md](deploy-local.md) · [deploy-aws.md](deploy-aws.md) · [deploy-agent.md](deploy-agent.md). Pre-deploy E2E: [agent-e2e-testing.md](agent-e2e-testing.md).

Design details: [aws.md](aws.md), [agent.md](agent.md), [plan.md](plan.md).

## Prerequisites

| Piece                                | Need                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------ |
| Node.js ≥ 22.18                      | monorepo tooling + **native TypeScript type stripping** (no `tsc` build) |
| pnpm                                 | workspaces (`packageManager` in root `package.json`)                     |
| Docker                               | **DynamoDB Local** for local API paths                                   |
| Git 2.20+                            | worktrees                                                                |
| AI CLIs (optional for real sessions) | Codex / Claude / etc. on the agent host                                  |

```bash
pnpm install
```

---

## Local development

**→ [local-development.md](local-development.md)** — DynamoDB Local, `pnpm local:api` / `local:agent` / `local:web`, one-shot e2e, operator manage routes, and the quality gate.

Quick start:

```bash
pnpm local:dynamodb && pnpm local:dynamodb:ready
pnpm local:e2e
pnpm check
```

---

## AWS control plane (later phases)

Full AWS ops: **[deploy-aws.md](deploy-aws.md)**. Index: [deploy.md](deploy.md).

Short checklist:

1. `pnpm install`
2. Configure secrets (do not commit):
   - `HARNESS_ADMINS` — base64 JSON `[{ "username", "password" }]`
   - `HARNESS_SESSION_SECRET` — long random string for UI JWTs
   - `WEB_ORIGIN` — browser origin for CORS
3. Deploy: `pnpm --filter @auto-harness/cdk deploy` (**only when the CDK app is fully implemented** — see [deploy-aws.md](deploy-aws.md))
4. Create users / service accounts; bind agent API key; add repositories; install agents per [deploy-agent.md](deploy-agent.md)

See [aws.md](aws.md), [auth.md](auth.md), [security.md](security.md).

---

## VPS agent (production shape)

Install / update / teardown: **[deploy-agent.md](deploy-agent.md)**. Locally: `run-session` / e2e in [local-development.md](local-development.md) or daemon start in [deploy-local.md](deploy-local.md).

Agent config includes optional `apiUrl` / `apiKey` for cloud connect. All execution still resolves to **named, fixed argv** (D4), now via the global Provider/Provider Account/Command catalogs rather than host-local command profiles. Subscription CLIs and secrets live only on the host — see [why.md](why.md), [costs.md](costs.md).

---

## Security reminders

- No secrets in prompts or REST session bodies
- Agent holds git + AI credentials on the VPS
- Free-form shell commands are not accepted over the API — only a catalog Provider Account or Command

See [auth.md](auth.md), [security.md](security.md).
