# Docs index

Short entry points. Prefer the focused pages over mega-guides.

## Get running

| Doc                                          | Contents                                                    |
| -------------------------------------------- | ----------------------------------------------------------- |
| [local-development.md](local-development.md) | Local stack: DynamoDB Local, `pnpm local:*`, e2e, manage UI |
| [agent-e2e-testing.md](agent-e2e-testing.md) | **Pre-deploy E2E** for coding agents (stack + real CLI)     |
| [deploy.md](deploy.md)                       | Deploy index → local / AWS / VPS agent                      |
| [deploy-local.md](deploy-local.md)           | Local stack deploy / update / teardown                      |
| [deploy-aws.md](deploy-aws.md)               | AWS control plane deploy / update / teardown                |
| [deploy-agent.md](deploy-agent.md)           | VPS agent install / update / teardown                       |
| [setup.md](setup.md)                         | Install, AWS deploy overview, VPS agent production shape    |
| [cli.md](cli.md)                             | `auto-harness-agent` commands                               |
| [harness.md](harness.md)                     | Repo harness hookup examples, requirements                  |

## Protocols

| Doc                          | Contents                      |
| ---------------------------- | ----------------------------- |
| [api.md](api.md)             | REST `/api/v1`                |
| [websocket.md](websocket.md) | Agent + UI real-time messages |

## Design

| Doc                                | Contents                                              |
| ---------------------------------- | ----------------------------------------------------- |
| [why.md](why.md)                   | Why this product; subscriptions + non-interactive CLI |
| [architecture.md](architecture.md) | Two-plane overview + flows                            |
| [aws.md](aws.md)                   | Control plane internals                               |
| [agent.md](agent.md)               | VPS agent internals                                   |
| [auth.md](auth.md)                 | Credentials, roles, login, agent binding              |
| [security.md](security.md)         | Principles, transport, hardening, threat boundaries   |
| [web.md](web.md)                   | Web UI behavior                                       |
| [integrations.md](integrations.md) | Slack (+ future)                                      |
| [plan.md](plan.md)                 | Phases + data model                                   |
| [costs.md](costs.md)               | Cost notes                                            |
