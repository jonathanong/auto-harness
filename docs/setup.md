# Setup

Install Auto Harness and run it in production-shaped environments. **Day-to-day local work (DynamoDB Local, `pnpm local:*`, e2e, manage UI) lives in [local-development.md](local-development.md).**

**Deploy / update / teardown:** [deploy.md](deploy.md) (index) · [deploy-local.md](deploy-local.md) · [deploy-aws.md](deploy-aws.md) · [deploy-host-daemon.md](deploy-host-daemon.md). Pre-deploy E2E: [host-daemon-e2e-testing.md](host-daemon-e2e-testing.md).

Design details: [aws.md](aws.md), [host-daemon.md](host-daemon.md), [plan.md](plan.md).

## Prerequisites

| Piece                                | Need                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------ |
| Node.js ≥ 22.18                      | monorepo tooling + **native TypeScript type stripping** (no `tsc` build) |
| pnpm                                 | workspaces (`packageManager` in root `package.json`)                     |
| Docker                               | **DynamoDB Local** for local API paths                                   |
| Git 2.36+                            | worktrees and checkout recovery                                          |
| AI CLIs (optional for real sessions) | Codex / Claude / etc. on the agent host                                  |

```bash
pnpm install
```

---

## Local development

**→ [local-development.md](local-development.md)** — DynamoDB Local, `pnpm local:api` / `local:daemon` / `local:web`, one-shot e2e, operator manage routes, and the quality gate.

Quick start:

```bash
pnpm local:dynamodb && pnpm local:dynamodb:ready
pnpm local:e2e
pnpm check
```

---

## AWS control plane

Full AWS ops: **[deploy-aws.md](deploy-aws.md)**. Index: [deploy.md](deploy.md).

Short checklist:

1. `pnpm install`
2. Create the three environment-scoped SecureStrings as described in [deploy-aws.md](deploy-aws.md#secrets-and-config-never-commit) (Parameter Store UI, or the `aws ssm put-parameter` form given there).
3. Set `AWS_REGION` and `HARNESS_DEPLOY_ENVIRONMENT`, then run `pnpm --filter @auto-harness/cdk run deploy`. (Note the `run` — `pnpm --filter @auto-harness/cdk deploy` without it invokes pnpm's own built-in `deploy` command, not this package's script, and does not do what you want.)
4. Open the printed `WebUrl`. Sign in as **admin** to create accounts,
   host slots, repositories, and providers (operators create sessions; they
   do not Add host), then persist agents with
   `pnpm local:daemon install-service` per
   [deploy-host-daemon.md](deploy-host-daemon.md). Codex is `codex exec`,
   not `-p`.

See [aws.md](aws.md), [auth.md](auth.md), [security.md](security.md).

---

## VPS agent (production shape)

Install / update / teardown: **[deploy-host-daemon.md](deploy-host-daemon.md)**. Locally: `run-session` / e2e in [local-development.md](local-development.md) or daemon start in [deploy-local.md](deploy-local.md).

Persist the host daemon on Linux (systemd), macOS (LaunchAgent, current user), or Windows
(logon scheduled task, current user) from the checkout:

```bash
export HARNESS_HOST_ID='<bound-host-id>'
export HARNESS_API_URL='<CloudFront WebUrl>'
export HARNESS_API_KEY='<bound-daemon-key>'
pnpm local:daemon install-service
```

Copy-pasteable command, every OS. Linux refuses `local-1` / `http://127.0.0.1:7420` / an empty
key when writing a new env file. Details and the Linux VPS copy-unit path:
[deploy-host-daemon.md](deploy-host-daemon.md).

Agent config includes optional `apiUrl` / `apiKey` for cloud connect. All execution still resolves to **named, fixed argv** (D4), now via the global Provider/Provider Account/Command catalogs rather than host-local command profiles. Subscription CLIs and secrets live only on the host — see [why.md](why.md), [costs.md](costs.md).

---

## Security reminders

- No secrets in prompts or REST session bodies
- Agent holds git + AI credentials on the VPS
- Free-form shell commands are not accepted over the API — only a catalog Provider Account or Command

See [auth.md](auth.md), [security.md](security.md).
