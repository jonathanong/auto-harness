# Deploy, update, and teardown

Ops is split by **surface**. Pick the doc for what you are running.

| Surface                                                                          | Doc                                                | Maturity                                                                |
| -------------------------------------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------- |
| **Local** — DynamoDB Local + API + optional web + agent                          | **[deploy-local.md](deploy-local.md)**             | **Supported** today                                                     |
| **AWS control plane** — persistence plus REST, WebSocket, and scheduled runtimes | **[deploy-aws.md](deploy-aws.md)**                 | **Synthesizable only**; no deployment path or account-backed validation |
| **VPS agent** — daemon, profiles, worktrees                                      | **[deploy-host-daemon.md](deploy-host-daemon.md)** | **Partial** (local start supported; systemd is the production shape)    |

No AWS surface has been deployed or validated against an AWS account by this repository. A
successful CDK synth proves template shape only, not deployability or runtime behavior.

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

### AWS control-plane synthesis

1. [deploy-aws.md](deploy-aws.md) — synthesize the persistence and REST/WebSocket/cron runtime stacks
2. Do not point agents at the templates: the repository has no deployment path, and no AWS
   account-backed runtime has been deployed or validated

### Updates

| What changed                   | Where to look                                            |
| ------------------------------ | -------------------------------------------------------- |
| Local monorepo / API process   | [deploy-local.md](deploy-local.md#update)                |
| AWS foundation schema          | [deploy-aws.md](deploy-aws.md#synthesize-the-foundation) |
| Agent binary, config, profiles | [deploy-host-daemon.md](deploy-host-daemon.md#update)    |

Prefer **control plane first**, then **agents**. Agent updates are manual today: an operator must
request drain, wait for in-flight sessions, install the update, and restart the daemon. Automatic
download/restart orchestration remains future work.

### Teardown

| Surface                              | Where to look                                                                 |
| ------------------------------------ | ----------------------------------------------------------------------------- |
| Local processes + DynamoDB container | [deploy-local.md](deploy-local.md#teardown)                                   |
| AWS disposable foundation            | [Manual deletion constraints](deploy-aws.md#teardown-a-disposable-foundation) |
| Single agent host                    | [deploy-host-daemon.md](deploy-host-daemon.md#teardown)                       |

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
