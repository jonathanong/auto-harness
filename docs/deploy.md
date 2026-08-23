# Deploy, update, and teardown

Ops is split by **surface**. Pick the doc for what you are running.

| Surface                                                                         | Doc                                                | Maturity                                                                        |
| ------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------- |
| **Local** — DynamoDB Local + API + optional web + agent                         | **[deploy-local.md](deploy-local.md)**             | **Supported** today                                                             |
| **AWS control plane** — serverless web, REST, WebSocket, schedules, and storage | **[deploy-aws.md](deploy-aws.md)**                 | **Supported** deploy, update, and teardown lifecycle                            |
| **VPS agent** — daemon, profiles, worktrees                                     | **[deploy-host-daemon.md](deploy-host-daemon.md)** | **Packaged** unit validated locally/CI; production host install is operator-run |

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

1. Create the three environment-scoped SecureStrings — Parameter Store UI or CLI, see
   [deploy-aws.md#secrets-and-config-never-commit](deploy-aws.md#secrets-and-config-never-commit)
2. [deploy-aws.md](deploy-aws.md#deploy-a-new-environment) — deploy and health-check the control plane
3. Connect hosts through the product UI
4. [qa-production.md](qa-production.md) — copy-pasteable production QA (host connect, real
   `grok`/`claude` sessions, schedule, purge) before trusting a new deployment. Laptop-only:
   [qa-local.md](qa-local.md)

### Updates

From a clean `main` checkout, the supported update path is two commands, in order:

```bash
pnpm deploy:aws
pnpm deploy:host
```

The AWS command fast-forwards `main`, installs the lockfile, updates and health-checks the control
plane, and handles the one-time session-drain ledger scheduler gate. The host command installs the
same locked checkout, gracefully restarts the persisted daemon service, and verifies its production
identity. Environment and first-rollout details remain in the surface-specific runbooks below.

| What changed                   | Where to look                                         |
| ------------------------------ | ----------------------------------------------------- |
| Local monorepo / API process   | [deploy-local.md](deploy-local.md#update)             |
| AWS control plane              | [deploy-aws.md](deploy-aws.md#update-an-environment)  |
| Agent binary, config, profiles | [deploy-host-daemon.md](deploy-host-daemon.md#update) |

Prefer **control plane first**, then **agents**. Agent updates are manual today: an operator must
request drain, wait for in-flight sessions, install the update, and restart the daemon. Automatic
download/restart orchestration remains future work.

Automation rollouts that need to quiesce only their own work use the authenticated
repository-principal session-drain API instead. They must keep their external admission gates off,
poll the durable operation to a terminal state, verify those gates again, then explicitly release
the Auto Harness fence. This does not cancel GitHub Actions runs or manage repository variables.

### Teardown

| Surface                                             | Where to look                                           |
| --------------------------------------------------- | ------------------------------------------------------- |
| Local processes + DynamoDB container                | [deploy-local.md](deploy-local.md#teardown)             |
| AWS control plane (stacks only)                     | [deploy-aws.md](deploy-aws.md#teardown)                 |
| AWS control plane (full decommission, irreversible) | [deploy-aws.md](deploy-aws.md#purge-irreversible)       |
| Single agent host                                   | [deploy-host-daemon.md](deploy-host-daemon.md#teardown) |

Always drain agents before destroying an AWS control plane.

`teardown` alone does not remove a `retain`-policy environment's data or its
three bootstrap SSM parameters — see
[deploy-aws.md#purge-irreversible](deploy-aws.md#purge-irreversible) for the
separate, irreversible `purge` operation that actually decommissions an
environment.

---

## Related

| Doc                                                      | Role                                           |
| -------------------------------------------------------- | ---------------------------------------------- |
| [deploy-local.md](deploy-local.md)                       | Local deploy / update / teardown               |
| [deploy-aws.md](deploy-aws.md)                           | AWS deploy, update, and teardown lifecycle     |
| [deploy-host-daemon.md](deploy-host-daemon.md)           | VPS agent install / update / teardown          |
| [qa-production.md](qa-production.md)                     | Production QA: restore/deploy, UI, host, purge |
| [qa-local.md](qa-local.md)                               | Local E2E QA: gates, UI, real CLIs, no AWS     |
| [host-daemon-e2e-testing.md](host-daemon-e2e-testing.md) | Pre-deploy E2E checklist                       |
| [local-development.md](local-development.md)             | Local runbook                                  |
| [setup.md](setup.md)                                     | Install overview                               |
