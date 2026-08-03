# Setup

Install Auto Harness and run it in production-shaped environments. **Day-to-day local work (DynamoDB Local, `pnpm local:*`, e2e, manage UI) lives in [local-development.md](local-development.md).**

**Deploy / update / teardown (local + AWS/VPS ops):** [deploy.md](deploy.md). Pre-deploy E2E: [agent-e2e-testing.md](agent-e2e-testing.md).

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

Full ops (deploy, update, teardown, secrets, post-deploy smoke): **[deploy.md](deploy.md)**.

Short checklist:

1. `pnpm install`
2. Configure secrets (do not commit):
   - `HARNESS_ADMINS` — base64 JSON `[{ "username", "password" }]`
   - `HARNESS_SESSION_SECRET` — long random string for UI JWTs
   - `WEB_ORIGIN` — browser origin for CORS
3. Deploy: `pnpm --filter @auto-harness/cdk deploy` (**only when the CDK app is fully implemented** — see [deploy.md](deploy.md) maturity table)
4. Create users / service accounts; bind agent API key; add repositories

See [aws.md](aws.md), [auth.md](auth.md), [security.md](security.md).

---

## VPS agent (production shape)

Production uses WebSocket `start` (agent daemon). Locally, use `run-session` / e2e as in [local-development.md](local-development.md).

Agent config includes optional `apiUrl` / `apiKey` for cloud connect. **commandProfiles** stay required for all execution (D4).

Subscription CLIs and secrets live only on the host — see [why.md](why.md), [costs.md](costs.md).

Env vars:

| Variable              | Required  | Default                            |
| --------------------- | --------- | ---------------------------------- |
| `HARNESS_CONFIG_PATH` | no        | `./auto-harness-agent.config.json` |
| `HARNESS_AGENT_ID`    | no        | config / hostname                  |
| `HARNESS_API_URL`     | for cloud | config `apiUrl`                    |
| `HARNESS_API_KEY`     | for cloud | config `apiKey`                    |
| `HARNESS_LOG_LEVEL`   | no        | `info`                             |

---

## Security reminders

- No secrets in prompts or REST session bodies
- Agent holds git + AI credentials on the VPS
- Free-form shell commands are not accepted over the API — only named `commandProfile`s

See [auth.md](auth.md), [security.md](security.md).
