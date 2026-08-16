# Deploy — AWS control plane

**Runtime infrastructure available for synthesis.** `services/cdk` synthesizes
the persistence foundation plus HTTP/WebSocket API Gateway, bundled Lambda
adapters, and an EventBridge-triggered cron Lambda. An account-backed deployment
proof remains future work; this repository deliberately provides no deploy command.
Architecture: [aws.md](aws.md).

Ops index: [deploy.md](deploy.md). Local stack: [deploy-local.md](deploy-local.md). VPS agent: [deploy-host-daemon.md](deploy-host-daemon.md).

---

## Maturity

| Item                         | Status                                                            |
| ---------------------------- | ----------------------------------------------------------------- |
| Design / data model          | Documented in [aws.md](aws.md)                                    |
| CDK package (`services/cdk`) | Synthesizable persistence + REST/WebSocket runtime stacks         |
| Runtime deployment           | Not implemented; there is deliberately no package `deploy` script |

Do not treat a successful synth as an AWS deployment claim. It validates the
CloudFormation shape only.

---

## Prerequisites (for synthesis)

- Node ≥22.18 and pnpm
- `pnpm install` from the repository root (the CDK CLI is a package development dependency)

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

Populate the three SecureString parameters **before deployment, or at latest before
the first Lambda invocation** (synthesis itself never reads a parameter value, so it
does not need this step first; deploy and provisioning are independent of each other,
but every cold start does need it). CloudFormation cannot create a `SecureString`
parameter itself, so this is always a separate, out-of-band step, run once per
environment:

```bash
aws ssm put-parameter --type SecureString --overwrite \
  --name /auto-harness/harness-admins --value "$(echo '[{"username":"admin","password":"..."}]' | base64)"
aws ssm put-parameter --type SecureString --overwrite \
  --name /auto-harness/harness-session-secret --value "$(openssl rand -base64 32)"
aws ssm put-parameter --type SecureString --overwrite \
  --name /auto-harness/harness-cursor-secret --value "$(openssl rand -base64 32)"
```

If a Lambda cold-starts before these are populated, that invocation fails — but the
failure does not stick: the next invocation retries the fetch rather than reusing a
cached failure for the rest of that container's lifetime, so provisioning late is a
recoverable mistake, not one that needs a container recycle to clear.

The stack parameters `HarnessAdminsSsmParam`, `HarnessSessionSecretSsmParam`,
and `HarnessCursorSecretSsmParam` default to the parameter names above; override
them at deploy time only if you name your parameters differently. CloudFormation
rejects an override that does not start with `/` — an SSM parameter ARN always
needs a leading slash, whether it comes from a hierarchical name's own `/` or one
supplied separately, so this repo requires the former rather than guessing which
case applies. Each Lambda's IAM role is granted `ssm:GetParameter` scoped to
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
| `WEB_ORIGIN`           | CORS allow-list for the web UI origin                                                                                                        |
| Table names / prefix   | From stack (see [aws.md](aws.md) env table)                                                                                                  |
| `ARCHIVE_BUCKET`       | S3 archive bucket                                                                                                                            |
| `WS_API_ENDPOINT`      | API Gateway Management API for `postToConnection`                                                                                            |
| `KMS_KEY_ID`           | Optional — Slack / integration secrets                                                                                                       |
| Rate-limit variables   | `HARNESS_RATE_LIMIT_*`, `HARNESS_WS_RATE_LIMIT_PER_SECOND`, and `HARNESS_RATE_LIMIT_FAIL_MODE`; see [security.md](security.md#rate-limiting) |

**Rotation:** `aws ssm put-parameter --overwrite` with the new value — no redeploy
required. Existing warm Lambda containers keep the value they fetched at their own
cold start until they naturally recycle; force an immediate rollover by updating
any Lambda config field (a no-op environment variable touch is enough) to recycle
containers early. Admin bootstrap rotation ([auth.md](auth.md)) is the same
`put-parameter` step against the admins parameter.

---

## Synthesize the control plane

```bash
pnpm install
pnpm --filter @auto-harness/cdk synth
```

The app emits `AutoHarnessFoundation` and `AutoHarnessRuntime`. The foundation
creates tables named `AutoHarness-*` and retains data resources on replacement
and deletion. The runtime creates three Node.js 22 Lambdas, HTTP and WebSocket
API Gateway APIs, a one-minute EventBridge rule, and a rotating KMS key for
integration secrets. Lambda code
is bundled locally with esbuild during synthesis.
Use CDK context to create a deliberately named disposable environment:

```bash
pnpm --filter @auto-harness/cdk synth -- \
  -c tablePrefix=Review20 \
  -c archiveBucketName=review-20-cdk-foundation-archives \
  -c runtimeStackName=Review20Runtime \
  -c removalPolicy=destroy
```

### Teardown a disposable foundation

The repository has no deploy or destroy script. If an operator independently
deploys a foundation synthesized with `removalPolicy=destroy`, delete it with
the same external deployment tool.

`removalPolicy` accepts only `retain` (the default) or `destroy`. With
`destroy`, CloudFormation still cannot remove a non-empty archive bucket; empty
it explicitly before deleting the stack. The foundation deliberately does not
enable CDK `autoDeleteObjects`, because that feature adds a custom-resource
Lambda and would exceed this stack's no-runtime-resources boundary. Do not
choose `destroy` for data that must survive a stack replacement.

### Stack parameters and outputs

Deployment tooling must supply the runtime stack's `HarnessAdminsSsmParam`,
`HarnessSessionSecretSsmParam`, and `HarnessCursorSecretSsmParam` parameters
(SSM parameter names — default values point at the names used in the
`put-parameter` commands above) and exact `WebOrigin`. The three secret values
themselves are never CDK parameters and must never be stored in CDK context or
source control — only in SSM.

| Output                                                      | Consumer                                          |
| ----------------------------------------------------------- | ------------------------------------------------- |
| `TablePrefix`; `UsersTableName` through `CommandsTableName` | Current storage naming / future API configuration |
| `ArchiveBucketName`, `ArchiveBucketArn`                     | Future archival runtime configuration             |
| `ApiDataAccessPolicyArn`, `ArchiveDataAccessPolicyArn`      | Future runtime-role attachments                   |
| `RestApiUrl`, `WebSocketUrl`, `IntegrationKeyArn`           | Runtime clients and integration encryption        |

Synth output is not a deployment claim. Before adding a repository deploy path,
add bootstrap/account requirements, explicit deploy and rollback commands, and
an account-backed REST/WebSocket/cron smoke test.

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
| Before an AWS deployment claim | An implemented runtime deploy path and account-backed E2E proof           |

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
