# Deploy — AWS control plane

**Design target.** API Gateway, Lambda, DynamoDB, S3, EventBridge. Architecture: [aws.md](aws.md).

Ops index: [deploy.md](deploy.md). Local stack: [deploy-local.md](deploy-local.md). VPS agent: [deploy-host-daemon.md](deploy-host-daemon.md).

---

## Maturity

| Item                                     | Status                                                                                              |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Design / data model                      | Documented in [aws.md](aws.md)                                                                      |
| CDK package (`services/cdk`)             | Table metadata / identity only — **not** a full deployable stack yet                                |
| `pnpm --filter @auto-harness/cdk deploy` | **Not production-ready** until a real CDK app lands and this runbook is validated in a real account |

Do **not** treat the commands below as battle-tested until that lands. They are the **ops contract** to implement and operate against.

---

## Prerequisites (when deploying)

- AWS account + credentials with rights for CloudFormation/CDK, Lambda, API Gateway, DynamoDB, S3, EventBridge, IAM, (optional) KMS
- Node 22.x for Lambda runtime alignment when packaging
- `cdk` CLI / `aws` CLI bootstrap in the target account/region
- Pre-deploy local proof green: [host-daemon-e2e-testing.md](host-daemon-e2e-testing.md)

---

## Secrets and config (never commit)

| Variable                 | Purpose                                                     |
| ------------------------ | ----------------------------------------------------------- |
| `HARNESS_ADMINS`         | Base64 JSON `[{ "username", "password" }]` bootstrap admins |
| `HARNESS_SESSION_SECRET` | JWT signing for UI session cookies                          |
| `WEB_ORIGIN`             | CORS allow-list for the web UI origin                       |
| Table names / prefix     | From stack (see [aws.md](aws.md) env table)                 |
| `ARCHIVE_BUCKET`         | S3 archive bucket                                           |
| `WS_API_ENDPOINT`        | API Gateway Management API for `postToConnection`           |
| `KMS_KEY_ID`             | Optional — Slack / integration secrets                      |

**Rotation:** change secret in the secret store / stack parameter → redeploy or update function configuration → verify login/WS. Admin bootstrap rotation requires redeploy of the Lambda env that holds `HARNESS_ADMINS` ([auth.md](auth.md)).

---

## Deploy

Intended shape (update paths when the CDK app lands under `services/cdk`):

```bash
pnpm install
# bootstrap once per account/region if needed:
#   npx cdk bootstrap aws://ACCOUNT/REGION

# synthesize / deploy (illustrative — enable when package scripts exist)
pnpm --filter @auto-harness/cdk deploy
# or: npx cdk deploy --app '…' --all
```

### Expected stack outputs

| Output              | Consumer                                                                          |
| ------------------- | --------------------------------------------------------------------------------- |
| `RestApiUrl`        | Web UI, CI `HARNESS_API_URL`                                                      |
| `WebSocketUrl`      | Agent connect (`wss://…/ws`) — see [deploy-host-daemon.md](deploy-host-daemon.md) |
| `ArchiveBucketName` | Ops                                                                               |
| `Region`            | Clients                                                                           |

### Post-deploy smoke (minimum)

1. `GET {RestApiUrl}/health` or equivalent health route
2. Create operator service account / bind agent key ([auth.md](auth.md#vps-agent-authentication))
3. Register at least one repository
4. Connect one agent ([deploy-host-daemon.md](deploy-host-daemon.md))
5. `POST /sessions` + observe assign over WebSocket → terminal status

---

## Update

| Change                      | Procedure                                                                                                         |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Lambda/handler code         | Build/bundle → `cdk deploy` (or pipeline) → verify health + one session                                           |
| Infra (tables, routes, IAM) | `cdk diff` → `cdk deploy` → watch CloudWatch for errors                                                           |
| Env / secrets               | Update parameter store / CDK context → redeploy or `update-function-configuration` → smoke login + agent register |
| Breaking API changes        | Drain agents ([deploy-host-daemon.md](deploy-host-daemon.md)) → deploy control plane → roll agents → re-run E2E   |
| Data migrations             | Prefer additive DynamoDB attributes; document any one-time backfill in the PR                                     |

> **Concurrency identity rename:** if an existing deployment used the legacy
> `concurrencyKey` attribute, perform this migration as a short maintenance
> window. First pause all schedules (and prevent schedule-triggering workers
> from running), then stop automatic and manual session creation. Wait until
> the control-plane list/metrics show **zero queued and zero running sessions**;
> terminal history may remain. Deploy the `concurrencyId` code and any required
> table/index changes, run the health check and a smoke session, then re-enable
> manual/automatic session creation and resume schedules. Do not automatically
> backfill the field: legacy rows can contain more than one active session for
> the same key, so a lock owner cannot be selected without changing execution
> semantics. New sessions use `concurrencyId` after the upgrade.

Prefer **control plane first**, then agents, so old agents fail closed on unknown messages rather than new agents talking to old APIs.

> **One-time backfill required if deploying onto a pre-existing populated environment:** the
> `agentId`→`hostId` and host inventory `commandProfile`→Provider Account attachments/catalog Commands renames changed
> persisted attribute names on the Sessions, Worktrees, Connections, and host-inventory tables
> without a compatibility shim. Rows written before this rename still carry the old attribute
> names and will hydrate with `hostId`/target fields `undefined`. There is no such environment
> today (this rename has only run against ephemeral local DynamoDB), so no backfill has been
> written — write and run one (or wipe and recreate the tables, per Teardown) before deploying
> this change over any environment with existing data.

---

## Teardown

```bash
# After confirming no production traffic / agents drained
pnpm --filter @auto-harness/cdk destroy
# or: npx cdk destroy --all
```

Also:

1. Drain and stop all VPS agents ([deploy-host-daemon.md](deploy-host-daemon.md#teardown)).
2. Confirm DynamoDB tables and S3 archive bucket deletion policy (retain vs destroy — set retention in CDK before first prod deploy).
3. Revoke service-account API keys and rotate any shared secrets.
4. Remove DNS / custom domain bindings if used.

Until destroy is validated in a non-prod account, treat teardown as **manual CloudFormation stack delete + agent stop**.

---

## Gates

| When                    | Gate                                                                        |
| ----------------------- | --------------------------------------------------------------------------- |
| Before AWS deploy claim | Local E2E green ([host-daemon-e2e-testing.md](host-daemon-e2e-testing.md))  |
| After AWS deploy        | Health, agent register, one full session lifecycle, CloudWatch errors quiet |

---

## Related

| Doc                                            | Role                 |
| ---------------------------------------------- | -------------------- |
| [deploy.md](deploy.md)                         | Ops index            |
| [deploy-local.md](deploy-local.md)             | Local stack          |
| [deploy-host-daemon.md](deploy-host-daemon.md) | VPS agent            |
| [aws.md](aws.md)                               | Control plane design |
| [auth.md](auth.md)                             | Keys, binding        |
| [setup.md](setup.md)                           | Install overview     |
