# Deploy, update, and teardown

Ops is split by **surface**. Pick the doc for what you are running.

| Surface                                                                          | Doc                                                | Maturity                                                                        |
| -------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------- |
| **Local** — DynamoDB Local + API + optional web + agent                          | **[deploy-local.md](deploy-local.md)**             | **Supported** today                                                             |
| **AWS control plane** — persistence plus REST, WebSocket, and scheduled runtimes | **[deploy-aws.md](deploy-aws.md)**                 | **Supported** deploy, update, and teardown lifecycle                            |
| **VPS agent** — daemon, profiles, worktrees                                      | **[deploy-host-daemon.md](deploy-host-daemon.md)** | **Packaged** unit validated locally/CI; production host install is operator-run |

AWS releases use the account-backed gate in [deploy-aws.md](deploy-aws.md#gates).

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

### AWS control-plane deployment

1. Create the three environment-scoped SecureStrings in the AWS Parameter Store UI
2. [deploy-aws.md](deploy-aws.md#deploy-a-new-environment) — deploy and health-check the control plane
3. Connect hosts through the product UI

### Updates

| What changed                   | Where to look                                         |
| ------------------------------ | ----------------------------------------------------- |
| Local monorepo / API process   | [deploy-local.md](deploy-local.md#update)             |
| AWS control plane              | [deploy-aws.md](deploy-aws.md#update-an-environment)  |
| Agent binary, config, profiles | [deploy-host-daemon.md](deploy-host-daemon.md#update) |

Prefer **control plane first**, then **agents**. Agent updates are manual today: an operator must
request drain, wait for in-flight sessions, install the update, and restart the daemon. Automatic
download/restart orchestration remains future work.

### Teardown

| Surface                              | Where to look                                           |
| ------------------------------------ | ------------------------------------------------------- |
| Local processes + DynamoDB container | [deploy-local.md](deploy-local.md#teardown)             |
| AWS control plane                    | [deploy-aws.md](deploy-aws.md#teardown)                 |
| Single agent host                    | [deploy-host-daemon.md](deploy-host-daemon.md#teardown) |

Always drain agents before destroying an AWS control plane.

---

## Related

| Doc                                                      | Role                                       |
| -------------------------------------------------------- | ------------------------------------------ |
| [deploy-local.md](deploy-local.md)                       | Local deploy / update / teardown           |
| [deploy-aws.md](deploy-aws.md)                           | AWS deploy, update, and teardown lifecycle |
| [deploy-host-daemon.md](deploy-host-daemon.md)           | VPS agent install / update / teardown      |
| [host-daemon-e2e-testing.md](host-daemon-e2e-testing.md) | Pre-deploy E2E checklist                   |
| [local-development.md](local-development.md)             | Local runbook                              |
| [setup.md](setup.md)                                     | Install overview                           |
