# Deploy, update, and teardown

Ops is split by **surface**. Pick the doc for what you are running.

| Surface                                                                | Doc                                    | Maturity                                                             |
| ---------------------------------------------------------------------- | -------------------------------------- | -------------------------------------------------------------------- |
| **Local** — DynamoDB Local + API + optional web + agent                | **[deploy-local.md](deploy-local.md)** | **Supported** today                                                  |
| **AWS control plane** — API Gateway, Lambda, DynamoDB, S3, EventBridge | **[deploy-aws.md](deploy-aws.md)**     | **Design only** (CDK not a full stack yet)                           |
| **VPS agent** — daemon, profiles, worktrees                            | **[deploy-agent.md](deploy-agent.md)** | **Partial** (local start supported; systemd is the production shape) |

Pre-deploy E2E (prove the stack before any cloud claim): [agent-e2e-testing.md](agent-e2e-testing.md).  
Day-to-day local commands: [local-development.md](local-development.md).  
Install overview: [setup.md](setup.md).  
Architecture: [aws.md](aws.md). Auth: [auth.md](auth.md).

---

## Typical flows

### Develop / pre-deploy on a laptop

1. [deploy-local.md](deploy-local.md) — start DynamoDB, API, optional web
2. [deploy-agent.md](deploy-agent.md) — point agent at `ws://127.0.0.1:7420/ws`
3. [agent-e2e-testing.md](agent-e2e-testing.md) — create → assign → complete

### Production-shaped (when AWS CDK is real)

1. [deploy-aws.md](deploy-aws.md) — deploy control plane
2. [deploy-agent.md](deploy-agent.md) — install agents against `wss://…/ws`
3. Smoke session + monitoring

### Updates

| What changed                   | Where to look                             |
| ------------------------------ | ----------------------------------------- |
| Local monorepo / API process   | [deploy-local.md](deploy-local.md#update) |
| AWS Lambda / infra / secrets   | [deploy-aws.md](deploy-aws.md#update)     |
| Agent binary, config, profiles | [deploy-agent.md](deploy-agent.md#update) |

Prefer **control plane first**, then **agents** (drain before agent restart).

### Teardown

| Surface                              | Where to look                               |
| ------------------------------------ | ------------------------------------------- |
| Local processes + DynamoDB container | [deploy-local.md](deploy-local.md#teardown) |
| AWS stack                            | [deploy-aws.md](deploy-aws.md#teardown)     |
| Single agent host                    | [deploy-agent.md](deploy-agent.md#teardown) |

Always drain agents before destroying the control plane.

---

## Related

| Doc                                          | Role                                  |
| -------------------------------------------- | ------------------------------------- |
| [deploy-local.md](deploy-local.md)           | Local deploy / update / teardown      |
| [deploy-aws.md](deploy-aws.md)               | AWS deploy / update / teardown        |
| [deploy-agent.md](deploy-agent.md)           | VPS agent install / update / teardown |
| [agent-e2e-testing.md](agent-e2e-testing.md) | Pre-deploy E2E checklist              |
| [local-development.md](local-development.md) | Local runbook                         |
| [setup.md](setup.md)                         | Install overview                      |
