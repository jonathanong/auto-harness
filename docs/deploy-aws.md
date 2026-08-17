# Deploy — AWS control plane

`services/cdk` owns the supported AWS lifecycle for the persistence foundation,
HTTP/WebSocket API Gateway, bundled Lambda adapters, EventBridge-triggered cron
Lambda, and the browser UI on CloudFront + Lambda. It exposes distinct `deploy`,
`update`, and `teardown` commands. There are no provisioned servers.
Architecture: [aws.md](aws.md).

Ops index: [deploy.md](deploy.md). Local stack: [deploy-local.md](deploy-local.md). VPS agent: [deploy-host-daemon.md](deploy-host-daemon.md).

---

## Maturity

| Item                         | Status                                                                           |
| ---------------------------- | -------------------------------------------------------------------------------- |
| Design / data model          | Documented in [aws.md](aws.md)                                                   |
| CDK package (`services/cdk`) | Persistence + REST/WebSocket runtime + serverless web stacks                     |
| Runtime lifecycle            | Supported by explicit deploy, update, and teardown scripts                       |
| Account-backed proof         | Deploy → update → REST/web health → teardown passed in `us-west-2` on 2026-08-17 |

---

## Prerequisites

- Node ≥22.18, pnpm, and Docker (used only to build the Lambda image)
- `pnpm install` from the repository root (the CDK CLI is a package development dependency)
- AWS CLI credentials with access to CloudFormation, CDK bootstrap resources,
  DynamoDB, S3, Lambda, API Gateway, EventBridge, CloudFront, ECR, IAM, KMS, and SSM
- `AWS_REGION` (or `AWS_DEFAULT_REGION`) set to the target region

---

## Secrets and config (never commit)

Three bootstrap secrets — `HARNESS_ADMINS`, `HARNESS_SESSION_SECRET`, and
`HARNESS_CURSOR_SECRET` — are **never** stored as plaintext Lambda environment
variables. A Lambda's environment configuration is readable in cleartext by
anyone with `lambda:GetFunctionConfiguration`, and appears in plaintext in
CloudTrail's Lambda-configuration events, so putting a real secret value there
defeats the point of a secret. Instead, each Lambda's environment holds only the
**name** of an SSM `SecureString` parameter; the Lambda fetches the actual value
from SSM once per cold start.

Create all three as `SecureString` values in the AWS Systems Manager Parameter
Store UI before deploying. For an environment named `<environment>`, the default
names are:

- `/auto-harness/<environment>/harness-admins`
- `/auto-harness/<environment>/harness-session-secret`
- `/auto-harness/<environment>/harness-cursor-secret`

The admin value follows [the bootstrap-admin format](auth.md#admin-accounts), and
both secret values must be independently generated high-entropy strings. The deploy
and update commands verify that all three parameters exist before changing a stack.
Their values are never passed to CDK, printed, or stored in source control.

Override a default parameter name with `HARNESS_ADMINS_SSM_PARAM`,
`HARNESS_SESSION_SECRET_SSM_PARAM`, or `HARNESS_CURSOR_SECRET_SSM_PARAM`. Each
Lambda's IAM role is granted `ssm:GetParameter` scoped to
exactly these three parameter ARNs, plus `kms:Decrypt` on the AWS-managed
`alias/aws/ssm` key (the default encryption key for a `SecureString` created
without specifying a customer-managed key) — scoped further with `kms:ViaService`
(so the grant only applies to SSM calling KMS on the Lambda's behalf, not a direct
`kms:Decrypt` for anything else encrypted under that shared key) and an
`EncryptionContext:PARAMETER_ARN` condition (so it only applies to decrypting
these three specific parameters).

| Variable               | Purpose                                                                                                                                      |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| SSM: bootstrap secrets | See above — `HARNESS_ADMINS` / `HARNESS_SESSION_SECRET` / `HARNESS_CURSOR_SECRET`, fetched from SSM at cold start, never a Lambda env var    |
| Table names / prefix   | From stack (see [aws.md](aws.md) env table)                                                                                                  |
| `ARCHIVE_BUCKET`       | S3 archive bucket                                                                                                                            |
| `WS_API_ENDPOINT`      | API Gateway Management API for `postToConnection`                                                                                            |
| `KMS_KEY_ID`           | Optional — Slack / integration secrets                                                                                                       |
| Rate-limit variables   | `HARNESS_RATE_LIMIT_*`, `HARNESS_WS_RATE_LIMIT_PER_SECOND`, and `HARNESS_RATE_LIMIT_FAIL_MODE`; see [security.md](security.md#rate-limiting) |

**Rotation:** replace the value in the Parameter Store UI; no redeploy is required.
Existing warm Lambda containers keep the value they fetched at their own
cold start until they naturally recycle; force an immediate rollover by updating
any Lambda config field (a no-op environment variable touch is enough) to recycle
containers early. Admin bootstrap rotation ([auth.md](auth.md)) is the same
`put-parameter` step against the admins parameter.

---

## Lifecycle configuration

All lifecycle commands use the same settings. Environment names are lowercase,
start with a letter, contain only letters, numbers, and dashes, and are at most 32
characters.

| Variable                        | Required             | Purpose                                                    |
| ------------------------------- | -------------------- | ---------------------------------------------------------- |
| `HARNESS_DEPLOY_ENVIRONMENT`    | Always               | Isolates stack, table, bucket, and SSM names               |
| `AWS_REGION`                    | Always               | AWS deployment region                                      |
| `HARNESS_DEPLOY_REMOVAL_POLICY` | No; default `retain` | `retain` for durable data or `destroy` for disposable data |
| `AWS_ACCOUNT_ID`                | No                   | Avoids the STS account lookup when already known           |
| `HARNESS_DEPLOY_CONFIRM`        | Teardown only        | Must exactly match `HARNESS_DEPLOY_ENVIRONMENT`            |

The generated names are `AutoHarness-<environment>-Foundation`,
`AutoHarness-<environment>-Runtime`, `AutoHarness-<environment>-Web`, and
`AutoHarness-<environment>-*` for tables.
The names are generic and do not depend on any repository connected later in the UI.

## Deploy a new environment

```bash
pnpm install
export AWS_REGION=us-west-2
export HARNESS_DEPLOY_ENVIRONMENT=production
pnpm --filter @auto-harness/cdk run deploy
```

`deploy` refuses to run if any application stack already exists, verifies the
three SSM parameters, bootstraps CDK in the selected account and region, deploys
all three stacks, calls the REST `/health` endpoint, loads the hosted `/login`
page, and prints both URLs. The shared
`CDKToolkit` bootstrap stack remains available for later environments.

For a disposable environment, set the removal policy before its first deploy:

```bash
export HARNESS_DEPLOY_REMOVAL_POLICY=destroy
pnpm --filter @auto-harness/cdk run deploy
```

## Update an environment

Use the same environment, region, removal policy, and any SSM overrides
used for deployment:

```bash
pnpm --filter @auto-harness/cdk run update
```

`update` requires the foundation stack, applies the current CDK app to all three
stacks, and runs the REST and web health checks. It also recreates missing runtime
or web stacks after a retained teardown.

## Teardown

Drain connected hosts first. Then supply the exact environment confirmation:

```bash
export HARNESS_DEPLOY_CONFIRM="$HARNESS_DEPLOY_ENVIRONMENT"
pnpm --filter @auto-harness/cdk run teardown
```

With the default `retain` policy, teardown removes the web and runtime stacks and
leaves the managed foundation stack and data in place. Run `update` to restore
them. With `destroy`, teardown removes all three application stacks and verifies
their absence.
The integration KMS key belongs to the foundation, so retained teardown preserves
the key needed to decrypt existing integration credentials. Under `destroy`, the
key enters AWS's seven-day pending-deletion window. Teardown does not remove the
account-level `CDKToolkit` stack or the three SSM parameters.

`removalPolicy` accepts only `retain` (the default) or `destroy`. With
`destroy`, CloudFormation still cannot remove a non-empty archive bucket; empty
it explicitly before deleting the stack. The foundation deliberately does not
enable CDK `autoDeleteObjects`, because that feature adds a custom-resource
Lambda and would exceed this stack's no-runtime-resources boundary. Do not
choose `destroy` for data that must survive a stack replacement.

## Stack parameters and outputs

The lifecycle script supplies the runtime stack's SSM parameter names. Secret
values themselves are never CDK parameters or context.

| Output                                                      | Consumer                                          |
| ----------------------------------------------------------- | ------------------------------------------------- |
| `TablePrefix`; `UsersTableName` through `CommandsTableName` | Current storage naming / future API configuration |
| `ArchiveBucketName`, `ArchiveBucketArn`                     | Future archival runtime configuration             |
| `ApiDataAccessPolicyArn`, `ArchiveDataAccessPolicyArn`      | Future runtime-role attachments                   |
| `IntegrationKeyArn`                                         | Foundation-owned integration encryption           |
| `RestApiUrl`, `WebSocketUrl`                                | Runtime clients                                   |
| `WebUrl`                                                    | Browser control-plane URL                         |

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

## Gates

| When                           | Gate                                                                      |
| ------------------------------ | ------------------------------------------------------------------------- |
| Before merge                   | `pnpm --filter @auto-harness/cdk synth` and deterministic synthesis tests |
| Before an AWS deployment claim | Deploy, update, REST/web health checks, and teardown in an AWS account    |

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
