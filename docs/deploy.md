# Deploy, update, and teardown

Ops is split by **surface**. Pick the doc for what you are running.

| Surface                                                                         | Doc                                                | Maturity                                                                                                                                                                  |
| ------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Local** — DynamoDB Local + API + optional web + agent                         | **[deploy-local.md](deploy-local.md)**             | **Supported** today                                                                                                                                                       |
| **AWS control plane** — serverless web, REST, WebSocket, schedules, and storage | **[deploy-aws.md](deploy-aws.md)**                 | **Supported** deploy/update/teardown in `us-west-2` (2026-08-17); short programmatic session dispatch proven 2026-08-18. Long-running CLI fleet E2E is still operator QA. |
| **VPS agent** — daemon, profiles, worktrees                                     | **[deploy-host-daemon.md](deploy-host-daemon.md)** | **Packaged** unit validated locally/CI; production host install is operator-run                                                                                           |
| **npm client** — manual version, tag, trusted publish, and GitHub Release       | **[release-client.md](release-client.md)**         | **Manual GitHub Actions release**                                                                                                                                         |
| **GitHub Actions** — manual `vX.Y.Z` tag and GitHub Release for SHA pins        | **[release-actions.md](release-actions.md)**       | **Manual GitHub Actions release**                                                                                                                                         |

AWS releases use the account-backed gate in [deploy-aws.md](deploy-aws.md#gates).

Deployment is always manual and operator-run — no CI workflow deploys to AWS or a host on merge
or release.

### Optional Sentry

Sentry is disabled unless the operator explicitly opts in. The independent
OpenTofu root is in [`opentofu/sentry`](../opentofu/sentry/README.md); it has a
remote backend supplied at `tofu init` time and must be applied separately with
an operator-approved saved plan. After applying it, load one environment's
public DSNs into the normal deploy environment and deploy as usual:

```bash
eval "$(HARNESS_DEPLOY_ENVIRONMENT=production pnpm --silent sentry:dsn)"
pnpm deploy:aws
pnpm deploy:host
```

With `HARNESS_SENTRY_ENABLED=1`, the AWS deploy path requires the matching API
and control-plane web DSNs. The host DSN is consumed by `deploy:host` through
the existing persisted service environment. The opted-in AWS deploy uploads the
control-plane web maps from inside its exact Docker build using the current Git
SHA; a failed upload stops deployment. The host pane has a separate explicit
local production-build step (`pnpm sentry:sourcemaps host-pane`). In both cases
the upload token never enters a runtime environment or artifact.

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
2. First environment: [deploy-aws.md#deploy-a-new-environment](deploy-aws.md#deploy-a-new-environment) —
   `cdk run deploy` deploys and health-checks the control plane. `pnpm deploy:aws` is update-only
   (see [Updates](#updates))
3. Connect hosts through the product UI
4. [qa-production.md](qa-production.md) — copy-pasteable production QA (host connect, real
   `grok`/`claude` sessions, schedule, purge) before trusting a new deployment. Laptop-only:
   [qa-local.md](qa-local.md)

### Updates

`pnpm deploy:aws` and `pnpm deploy:host` are **update** commands for an already-deployed
environment — every path through `scripts/deploy-aws.sh` ends in
`pnpm --filter @auto-harness/cdk run update`, never `deploy`. Standing up a first environment
instead runs [deploy-aws.md#deploy-a-new-environment](deploy-aws.md#deploy-a-new-environment)'s
`pnpm --filter @auto-harness/cdk run deploy` directly. Mind the `run` —
`pnpm --filter @auto-harness/cdk deploy` without it invokes pnpm's own built-in `deploy` command
instead of the package script (see [setup.md](setup.md)).

From a clean `main` checkout, the supported update path is two commands, in order:

```bash
pnpm deploy:aws
pnpm deploy:host
```

Both scripts require the `main` branch and a clean working tree. `deploy:aws` fetches and
fast-forwards to `origin/main` (refusing a local `main` that is ahead of or diverged from it) and
re-execs itself up to 3 times if `origin/main` moves mid-run; `deploy:host` instead requires
`main` to already match `origin/main`, erroring with instructions to run `deploy:aws` first
otherwise. Neither can update from a feature branch or a worktree; the lower-level
`pnpm --filter @auto-harness/cdk run update` is the escape hatch for that (see
[deploy-aws.md#update-an-environment](deploy-aws.md#update-an-environment)). `deploy:aws` also defaults to
`AWS_REGION=us-west-2` and `HARNESS_DEPLOY_ENVIRONMENT=production` when unset, so running it bare
updates **production** in **us-west-2**; set both explicitly for any other target.

The AWS command installs the lockfile, updates and health-checks the control plane, and handles
the one-time session-drain ledger scheduler gate. On Linux, the host command runs
from the writable `HARNESS_UPDATE_INSTALL_DIR/staging` checkout, gracefully restarts the persisted
daemon service, and verifies its production identity; the immutable active release changes only after
the signed updater and root-owned promotion helper validate it. Environment and first-rollout details
remain in the surface-specific runbooks below.

| What changed                   | Where to look                                         |
| ------------------------------ | ----------------------------------------------------- |
| Local monorepo / API process   | [deploy-local.md](deploy-local.md#update)             |
| AWS control plane              | [deploy-aws.md](deploy-aws.md#update-an-environment)  |
| Agent binary, config, profiles | [deploy-host-daemon.md](deploy-host-daemon.md#update) |

Prefer **control plane first**, then **agents**. Agent updates drain, wait for idle, verify a
signed manifest, stage/activate the artifact, and request a supervisor restart when
`HARNESS_UPDATE_MANIFEST_URL` and `HARNESS_UPDATE_PUBLIC_KEY` are set. The writable staging checkout
never becomes active directly. A failed activation rolls the previous artifact back and resumes
scheduling.

Automation rollouts that need to cancel and fence only their own Auto Harness sessions — not the
whole repository or host — use the authenticated repository-principal session-drain API instead.
It cancels the calling principal's own queued and running sessions for one repository and blocks
new ones from that principal until released. Callers must keep their external admission gates off,
poll the durable operation to a terminal state, verify those gates again, then explicitly release
the Auto Harness fence. This does not cancel GitHub Actions runs or manage repository variables —
those are the caller's responsibility to gate separately.

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
