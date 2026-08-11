# Deploy, update, and teardown

Ops is split by **surface**. Pick the doc for what you are running.

| Surface                                                            | Doc                                                | Maturity                                                             |
| ------------------------------------------------------------------ | -------------------------------------------------- | -------------------------------------------------------------------- |
| **Local** — DynamoDB Local + API + optional web + agent            | **[deploy-local.md](deploy-local.md)**             | **Supported** today                                                  |
| **AWS foundation** — DynamoDB, S3 archive, unassigned IAM policies | **[deploy-aws.md](deploy-aws.md)**                 | **Synthesizable only**; runtime control plane remains design work    |
| **VPS agent** — daemon, profiles, worktrees                        | **[deploy-host-daemon.md](deploy-host-daemon.md)** | **Partial** (local start supported; systemd is the production shape) |

Pre-deploy E2E (prove the stack before any cloud claim): [host-daemon-e2e-testing.md](host-daemon-e2e-testing.md).  
Day-to-day local commands: [local-development.md](local-development.md).  
Install overview: [setup.md](setup.md).  
Architecture: [aws.md](aws.md). Auth: [auth.md](auth.md).

---

## Typical flows

### Develop / pre-deploy on a laptop

1. [deploy-local.md](deploy-local.md) — start DynamoDB, API, optional web
2. [deploy-host-daemon.md](deploy-host-daemon.md) — point agent at `ws://127.0.0.1:7420/ws`
3. [host-daemon-e2e-testing.md](host-daemon-e2e-testing.md) — create → assign → complete

### AWS foundation synthesis

1. [deploy-aws.md](deploy-aws.md) — synthesize the DynamoDB/S3/IAM foundation
2. Do not point agents at it: REST and WebSocket runtime resources do not exist yet

### Updates

| What changed                   | Where to look                                         |
| ------------------------------ | ----------------------------------------------------- |
| Local monorepo / API process   | [deploy-local.md](deploy-local.md#update)             |
| AWS Lambda / infra / secrets   | [deploy-aws.md](deploy-aws.md#update)                 |
| Agent binary, config, profiles | [deploy-host-daemon.md](deploy-host-daemon.md#update) |

Prefer **control plane first**, then **agents** (drain before agent restart).

### Teardown

| Surface                              | Where to look                                           |
| ------------------------------------ | ------------------------------------------------------- |
| Local processes + DynamoDB container | [deploy-local.md](deploy-local.md#teardown)             |
| AWS stack                            | [deploy-aws.md](deploy-aws.md#teardown)                 |
| Single agent host                    | [deploy-host-daemon.md](deploy-host-daemon.md#teardown) |

Always drain agents before destroying the control plane.

---

## Related

| Doc                                                      | Role                                  |
| -------------------------------------------------------- | ------------------------------------- |
| [deploy-local.md](deploy-local.md)                       | Local deploy / update / teardown      |
| [deploy-aws.md](deploy-aws.md)                           | AWS deploy / update / teardown        |
| [deploy-host-daemon.md](deploy-host-daemon.md)           | VPS agent install / update / teardown |
| [host-daemon-e2e-testing.md](host-daemon-e2e-testing.md) | Pre-deploy E2E checklist              |
| [local-development.md](local-development.md)             | Local runbook                         |
| [setup.md](setup.md)                                     | Install overview                      |
