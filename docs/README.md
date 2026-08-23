# Docs index

Short entry points. Prefer the focused pages over mega-guides.

## Get running

| Doc                                                      | Contents                                                    |
| -------------------------------------------------------- | ----------------------------------------------------------- |
| [local-development.md](local-development.md)             | Local stack: DynamoDB Local, `pnpm local:*`, e2e, manage UI |
| [host-daemon-e2e-testing.md](host-daemon-e2e-testing.md) | Pre-deploy technical checklist (stack + real CLI)           |
| [qa-local.md](qa-local.md)                               | **Local E2E QA** — gates, UI, real CLIs, schedule, teardown |
| [qa-production.md](qa-production.md)                     | **Production QA** — AWS restore/deploy, UI, host, purge     |
| [deploy.md](deploy.md)                                   | Deploy index → local / AWS / VPS agent                      |
| [deploy-local.md](deploy-local.md)                       | Local stack deploy / update / teardown                      |
| [deploy-aws.md](deploy-aws.md)                           | AWS control plane deploy / update / teardown                |
| [deploy-host-daemon.md](deploy-host-daemon.md)           | VPS agent install / update / teardown                       |
| [release-client.md](release-client.md)                   | Manual npm client version, tag, and trusted publish         |
| [setup.md](setup.md)                                     | Install, AWS deploy overview, VPS agent production shape    |
| [cli.md](cli.md)                                         | `auto-harness-agent` commands                               |
| [harness.md](harness.md)                                 | Repo harness hookup examples, requirements                  |
| [GitHub dispatch action](../actions/dispatch/README.md)  | Fire-and-forget session dispatch from GitHub Actions        |
| [Node client](../modules/client/README.md)               | Public dependency-free `auto-harness-client`                |
| [e2e.md](e2e.md)                                         | Playwright E2E: ports, `data-pw` conventions, stack startup |

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
| [host-daemon.md](host-daemon.md)   | VPS agent internals                                   |
| [auth.md](auth.md)                 | Credentials, login, agent binding                     |
| [roles.md](roles.md)               | Named roles, capabilities, and the grant matrix       |
| [security.md](security.md)         | Principles, transport, hardening, threat boundaries   |
| [web.md](web.md)                   | Web UI behavior                                       |
| [terminology.md](terminology.md)   | Canonical UI vocabulary (nav labels, copy, `data-pw`) |
| [integrations.md](integrations.md) | Slack (+ future)                                      |
| [plan.md](plan.md)                 | Phases + data model                                   |
| [costs.md](costs.md)               | Cost notes                                            |
