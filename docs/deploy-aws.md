# Deploy — AWS control plane

`services/cdk` owns the supported AWS lifecycle for the persistence foundation,
HTTP/WebSocket API Gateway, bundled Lambda adapters, EventBridge-triggered cron
Lambda, and the browser UI on CloudFront + Lambda. It exposes distinct `deploy`,
`update`, and `teardown` commands. There are no provisioned servers.
Architecture: [aws.md](aws.md).

Ops index: [deploy.md](deploy.md). Local stack: [deploy-local.md](deploy-local.md). VPS agent: [deploy-host-daemon.md](deploy-host-daemon.md).

---

## Maturity

| Item                         | Status                                                                                                                                                                                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Design / data model          | Documented in [aws.md](aws.md)                                                                                                                                                                                                                               |
| CDK package (`services/cdk`) | Persistence + REST/WebSocket runtime + serverless web stacks                                                                                                                                                                                                 |
| Runtime lifecycle            | Supported by explicit deploy, update, and teardown scripts                                                                                                                                                                                                   |
| Account-backed proof         | Deploy → update → REST/web health → teardown passed in `us-west-2` on 2026-08-17. `purge` (including a real programmatic session created, dispatched, and completed in between) verified against a disposable `qa` environment in `us-west-2` on 2026-08-18. |

---

## Prerequisites

- Node ≥22.18, pnpm, and Docker (used only to build the Lambda image)
- `pnpm install` from the repository root (the CDK CLI is a package development dependency)
- AWS CLI credentials with access to CloudFormation, CDK bootstrap resources,
  DynamoDB, S3, Lambda, API Gateway, EventBridge, CloudFront, ECR, IAM, KMS, and SSM
- `AWS_REGION` (or `AWS_DEFAULT_REGION`) set to the target region

### macOS: isolate Docker credentials from the keychain

`deploy` / `update` build the Web Lambda image and run `docker login` against
the account's CDK ECR repository. On a Mac whose default credential helper is
the keychain, a non-interactive session (CI, an agent, a headless tmux pane)
fails with `User interaction is not allowed. (-25308)` after Foundation has
already updated. Isolate Docker credentials into a file-backed helper **before**
retrying — do **not** set `HOME` to a fake directory to dodge the keychain;
that also hides `~/.aws` and the next AWS call fails with
`Unable to locate credentials`.

```bash
cfg=$(mktemp -d /tmp/ah-docker-cfg.XXXXXX)
bin=$(mktemp -d /tmp/ah-docker-bin.XXXXXX)
store=$(mktemp /tmp/ah-docker-creds.XXXXXX)

cat > "$bin/docker-credential-none" <<'PY'
#!/usr/bin/env python3
import json, pathlib, sys
store = pathlib.Path(__import__("os").environ["AH_DOCKER_CREDS"])
cmd = sys.argv[1] if len(sys.argv) > 1 else ""
existing = json.loads(store.read_text()) if store.exists() else {}
if cmd == "store":
    data = json.load(sys.stdin)
    existing[data["ServerURL"]] = data
    store.write_text(json.dumps(existing))
elif cmd == "get":
    url = sys.stdin.read().strip()
    rec = existing.get(url)
    if rec is None:
        for key, val in existing.items():
            if url in key or key in url:
                rec = val
                break
    if rec is None:
        sys.exit(1)
    json.dump({"Username": rec["Username"], "Secret": rec["Secret"]}, sys.stdout)
elif cmd == "erase":
    url = sys.stdin.read().strip()
    existing.pop(url, None)
    store.write_text(json.dumps(existing))
elif cmd == "list":
    json.dump({k: v.get("Username", "") for k, v in existing.items()}, sys.stdout)
PY
chmod +x "$bin/docker-credential-none"
printf '%s\n' '{"credsStore":"none"}' > "$cfg/config.json"
export DOCKER_CONFIG="$cfg"
export AH_DOCKER_CREDS="$store"
export PATH="$bin:$PATH"
```

Then retry `pnpm --filter @auto-harness/cdk run update` (or `deploy`) in the
same shell.

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
Store UI before deploying, or with the AWS CLI. For an environment named
`<environment>`, the default names are:

- `/auto-harness/<environment>/harness-admins`
- `/auto-harness/<environment>/harness-session-secret`
- `/auto-harness/<environment>/harness-cursor-secret`

The admin value follows [the bootstrap-admin format](auth.md#admin-accounts), and
both secret values must be independently generated high-entropy strings. The deploy
and update commands verify that all three parameters exist before changing a stack.
Their values are never passed to CDK, printed, or stored in source control.

CLI form (verified against a real deploy):

```bash
environment=<environment>

admins_b64=$(echo '[{"username":"admin","password":"'"$(openssl rand -base64 24)"'"}]' | base64)
aws ssm put-parameter --type SecureString \
  --name "/auto-harness/$environment/harness-admins" \
  --value "$admins_b64"

aws ssm put-parameter --type SecureString \
  --name "/auto-harness/$environment/harness-session-secret" \
  --value "$(openssl rand -base64 32)"

aws ssm put-parameter --type SecureString \
  --name "/auto-harness/$environment/harness-cursor-secret" \
  --value "$(openssl rand -base64 32)"
```

Save the generated admin password somewhere you can read it back — it is not
retrievable from SSM in plaintext form without another `get-parameter` call, and
this is the only way to sign in until a user account exists. The parameter name
must keep the `/auto-harness/<environment>/...` prefix (or the matching
`*_SSM_PARAM` override) — the CDK-side parameter has `allowedPattern: "^/.+"`, and
a flat name builds a broken ARN that fails every Lambda cold start closed on
`AccessDenied`.

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

A fourth, non-secret parameter — `/auto-harness/<environment>/public-base-url` by
default, overridable with `HARNESS_PUBLIC_BASE_URL_SSM_PARAM` — holds the
CloudFront `WebUrl` this environment answers on. Unlike the three bootstrap
secrets, an operator never creates this one: the deploy lifecycle script writes
it itself (a plain `String`, not `SecureString` — see `--type String` in
`aws ssm put-parameter`), only after the Web stack deploys and its health check
passes, since Runtime cannot know Web's CloudFront domain at synth time (Web
depends on Runtime, not the reverse). Each Lambda's IAM role gets a separate
`ssm:GetParameter` grant scoped to just this parameter — no `kms:Decrypt`, since
a plain `String` parameter is never SSE-encrypted. A REST Lambda cold start that
finds this parameter missing or unreadable falls back to ControlPlane's own
`http://localhost:7421` default rather than failing — it only affects a
session's informational `url` field and the Slack integration's deep link, never
a security boundary.

| Variable               | Purpose                                                                                                                                      |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| SSM: bootstrap secrets | See above — `HARNESS_ADMINS` / `HARNESS_SESSION_SECRET` / `HARNESS_CURSOR_SECRET`, fetched from SSM at cold start, never a Lambda env var    |
| SSM: public base URL   | See above — `PUBLIC_BASE_URL_SSM_PARAM`, written by the deploy script after Web deploys, fetched at cold start, falls back gracefully        |
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

| Variable                             | Required             | Purpose                                                                                           |
| ------------------------------------ | -------------------- | ------------------------------------------------------------------------------------------------- |
| `HARNESS_DEPLOY_ENVIRONMENT`         | Always               | Isolates stack, table, bucket, and SSM names                                                      |
| `AWS_REGION` or `AWS_DEFAULT_REGION` | One required         | AWS deployment region                                                                             |
| `HARNESS_DEPLOY_REMOVAL_POLICY`      | No; default `retain` | `retain` for durable data or `destroy` for disposable data                                        |
| `AWS_ACCOUNT_ID`                     | No                   | Avoids the STS account lookup when already known                                                  |
| `HARNESS_DEPLOY_CONFIRM`             | Teardown/purge only  | Must exactly match `HARNESS_DEPLOY_ENVIRONMENT`                                                   |
| `HARNESS_DEPLOY_PURGE_CONFIRM`       | Purge only           | Must exactly match `destroy-all-data-in-<environment>`                                            |
| `HARNESS_DEPLOY_PURGE_SSM`           | No; default off      | Set to `1` to also delete all four SSM parameters (three bootstrap secrets + the public base URL) |

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

**If a first deploy fails partway** (e.g. `ROLLBACK_COMPLETE`): `deploy` refuses to
run again while any application stack exists, and `stackExists`
(`services/cdk/src/deployment-support.ts`) treats a `ROLLBACK_COMPLETE` shell as
existing — it only reports "absent" when the CloudFormation error text matches
`does not exist`. `update` cannot repair a create-failed stack either, since it
requires the foundation stack to already be healthy. Delete the failed stack(s)
manually (CloudFormation console or `aws cloudformation delete-stack`) before
retrying `deploy`. (This describes the code path; it was not deliberately
triggered during this doc's most recent account-backed verification, which
deployed cleanly on the first attempt.)

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

## Purge (irreversible)

Teardown alone cannot fully remove an environment deployed with the default
`retain` policy: the live CloudFormation template still carries
`DeletionPolicy: Retain` on the tables, archive bucket, and KMS key regardless of
what `HARNESS_DEPLOY_REMOVAL_POLICY` is set to at teardown time — that variable only
affects a stack's _next_ deploy, not resources already provisioned. Setting it to
`destroy` and re-running teardown does not retroactively change an already-deployed
stack's deletion policies, and teardown never removes the three bootstrap SSM
parameters.

`purge` is a separate, irreversible operation for actually decommissioning an
environment — including its data. It requires **two separate explicit
confirmations**, neither of which alone is enough — not as access control (both are
deterministic from the environment name, so they are not secret), but so a single
already-set variable can't silently authorize deleting everything:

```bash
export HARNESS_DEPLOY_CONFIRM="$HARNESS_DEPLOY_ENVIRONMENT"
export HARNESS_DEPLOY_PURGE_CONFIRM="destroy-all-data-in-$HARNESS_DEPLOY_ENVIRONMENT"
pnpm --filter @auto-harness/cdk run purge
```

In order: it destroys the web and runtime stacks (the archive bucket's only
writers — the runtime's scheduled Lambda archives session logs on a 1-minute
cron), retargets the foundation stack's resources to `DeletionPolicy: Delete` by
deploying the foundation alone with `removalPolicy=destroy` forced regardless of
the environment's configured policy, empties the archive bucket (including
noncurrent versions and delete markers — `aws s3 rm --recursive` alone is not
enough for a versioned bucket, and `cdk destroy` fails with `BucketNotEmpty`
otherwise), then destroys the foundation stack. It verifies afterward that no
application stack survives.

Two things purge deliberately does **not** finish immediately:

- **The integration KMS key** enters AWS's seven-day pending-deletion window —
  CloudFormation can only schedule deletion; seven days is the AWS minimum, and
  the key is not actually gone until that window elapses.
- **All four SSM parameters** (the three bootstrap secrets, hand-managed outside
  CDK and possibly shared with another environment, plus the deploy-script-managed
  public base URL) are left in place unless `HARNESS_DEPLOY_PURGE_SSM=1` is also
  set — deleting any of them is never implied by the rest of purge.

One thing purge does not finish **at all**, confirmed against a real purged
environment: each Lambda's `/aws/lambda/<function>` **CloudWatch log group is
created by the Lambda service on first invocation, not by CDK**, so it is not a
stack resource and `cdk destroy` never touches it. None of the three application
stacks configure `logRetention`, so these log groups default to never-expire and
outlive the environment they were created for indefinitely unless deleted by hand
(`aws logs delete-log-group --log-group-name /aws/lambda/<function-name>`) — find
them with `aws logs describe-log-groups --log-group-name-prefix
/aws/lambda/AutoHarness-<environment>`. [costs.md](costs.md#cloudwatch) already
recommends setting 7–14 day retention; no stack currently implements that
recommendation.

Purge also does not touch the account-level CDK bootstrap assets — the
`cdk-hnb659fds-assets-*` S3 staging bucket and the
`cdk-hnb659fds-container-assets-*` ECR repository. These are shared across every
environment deployed with this CDK bootstrap in the account, not scoped to one
environment, so purge deliberately leaves them for other environments to keep
using; they are not environment-specific residue in the way the log groups above
are.

`purge` refuses to run if no application stack exists at all, and throws if any
stack survives its destroy phases — it never reports success on a partial result.

## Stack parameters and outputs

The lifecycle script supplies the runtime stack's SSM parameter names. Secret
values themselves are never CDK parameters or context.

| Output                                                      | Consumer                                                                                           |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `TablePrefix`; `UsersTableName` through `CommandsTableName` | Current storage naming / future API configuration                                                  |
| `ArchiveBucketName`, `ArchiveBucketArn`                     | Future archival runtime configuration                                                              |
| `ApiDataAccessPolicyArn`, `ArchiveDataAccessPolicyArn`      | Future runtime-role attachments                                                                    |
| `IntegrationKeyArn`                                         | Foundation-owned integration encryption                                                            |
| `RestApiUrl`, `WebSocketUrl`                                | Deploy-time health checks and debugging only — **not** a value to hand to a host daemon; see below |
| `WebUrl`                                                    | Browser control-plane URL **and** the value to set as `HARNESS_API_URL` on every host daemon       |

`RestApiUrl` and `WebSocketUrl` are two different hostnames — API Gateway v2 fixes
`protocolType` at creation, so REST and WebSocket are necessarily separate APIs (see
[aws.md](aws.md#websocket-wss)). A host daemon's `HARNESS_API_URL` derives both its REST base
and its WebSocket target from one value, so it must be `WebUrl` (CloudFront), the one hostname
that fronts both APIs. `smokeDeployment` logs the agent endpoint derived from `WebUrl` at the
end of `deploy`/`update` for exactly this reason.

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

[qa-deployment.md](qa-deployment.md) is the copy-pasteable script for the second row —
deploy through a real programmatic session to purge, with the traps that aren't obvious
from this doc alone.

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
