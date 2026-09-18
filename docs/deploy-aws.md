# Deploy — AWS control plane

`services/cdk` owns the supported AWS lifecycle for the persistence foundation,
HTTP/WebSocket API Gateway, bundled Lambda adapters, EventBridge-triggered cron
Lambda, and the browser UI on CloudFront + Lambda. It exposes distinct `deploy`,
`update`, and `teardown` commands. There are no provisioned servers.
Architecture, IAM split, PITR, throttles, and alarms: [aws.md](aws.md).

Ops index: [deploy.md](deploy.md). Local stack: [deploy-local.md](deploy-local.md). VPS agent: [deploy-host-daemon.md](deploy-host-daemon.md).

---

## Maturity

| Item                         | Status                                                                                                                                                                                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Design / data model          | Documented in [aws.md](aws.md)                                                                                                                                                                                                                               |
| CDK package (`services/cdk`) | Persistence + REST/WebSocket runtime + serverless web stacks. Runtime IAM is split per function; DynamoDB PITR is on; HTTP/WS stages have throttles and operational CloudWatch alarms, plus redacted access logs when opted in.                              |
| Runtime lifecycle            | Supported by explicit deploy, update, and teardown scripts                                                                                                                                                                                                   |
| Account-backed proof         | Deploy → update → REST/web health → teardown passed in `us-west-2` on 2026-08-17. `purge` (including a real programmatic session created, dispatched, and completed in between) verified against a disposable `qa` environment in `us-west-2` on 2026-08-18. |

---

## Prerequisites

- Node ≥22.18, pnpm, and Docker (used only to build the Lambda image)
- `pnpm install` from the repository root (the CDK CLI is a package development dependency)
- AWS CLI credentials with access to CloudFormation, CDK bootstrap resources,
  DynamoDB, S3, Lambda, API Gateway, EventBridge, CloudFront, CloudWatch, ECR, IAM, KMS, and SSM
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

OAuth app credentials are optional. To enable the **Connect with Slack** flow,
store a JSON object containing `clientId`, `clientSecret`, and `signingSecret`
as an SSM `SecureString` at `HARNESS_SLACK_APP_SSM_PARAM` (default
`/auto-harness/<environment>/slack-app`). REST receives a narrowly scoped read
and decrypt grant for this parameter; Cron and Web do not. Manual bot-token and
signing-secret configuration remains available without this parameter.
Because this parameter is optional and may be shared across environments, purge
always leaves it in place; `HARNESS_DEPLOY_PURGE_SSM=1` does not delete it.

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
`http://localhost:7421` default for session `url` fields and Slack deep links
rather than failing the cold start. Slack OAuth start is stricter: it re-reads
and validates an HTTPS deployment URL, returning unavailable until one is
available rather than registering a localhost callback. Viewer WebSocket Origin
checks use the fetched URL only and deny the connection until a later connect
can read it; they never fall back to localhost. After writing the parameter, `deploy`/`update`
recycle the runtime Lambdas (a no-op `update-function-configuration`) so
already-warm containers re-read WebUrl instead of keeping the localhost session
URL fallback. AWS CLI v2 pages that JSON through `less` on a TTY; the lifecycle
sets `AWS_PAGER=""` so the dump prints to stdout and deploy continues.

A fifth credential — the CloudFront-ingress token — authenticates CloudFront's calls to
the REST API, but unlike every secret above it is entirely stack-managed: no operator
step creates or names it, and it is not SSM. The **Runtime** stack
(`services/cdk/src/cloudfront-ingress-secret.ts`, instantiated from
`services/cdk/src/runtime-stack.ts`) creates it as a Secrets Manager secret with a
Secrets-Manager-generated value (`generateSecretString`). Two consumers use it:

- **Runtime**'s CloudFront-ingress REQUEST authorizer Lambda
  (`services/cdk/src/runtime-ingress-authorizer.ts` wires the function and grants it
  `secretsmanager:GetSecretValue`; `services/api/src/cloudfront-ingress-authorizer.ts` is
  the handler) fetches the secret's current value via its
  `HARNESS_CLOUDFRONT_INGRESS_SECRET_ARN` environment variable and does a timing-safe
  comparison against the incoming `X-Auto-Harness-Ingress-Token` header before API
  Gateway invokes the REST Lambda.
- The **Web** stack (`services/cdk/src/web-stack.ts`) receives the same value as a CDK
  cross-stack reference — `cli.ts` passes the Runtime stack's
  `resources.cloudFrontIngressSecret` into the Web stack's props — and uses it twice: as
  CloudFront's origin custom header on the `/api/*` and `/health` behaviors (so every
  CloudFront-forwarded request already carries it), and as the plaintext
  `HARNESS_CLOUDFRONT_INGRESS_TOKEN` environment variable on the web Lambda itself. The
  web Lambda needs its own copy because its server-side calls
  (`services/web/src/lib/api.ts`, `services/web/src/proxy.ts`) hit the raw
  `HARNESS_API_HTTP` API Gateway URL directly, bypassing CloudFront, and must attach the
  header by hand to pass the authorizer.

There is no stack output for this secret and no `*_SSM_PARAM` override: unlike the three
bootstrap secrets above, an operator never creates it, names it, or reads its value.

| Variable                        | Purpose                                                                                                                                                                              |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| SSM: bootstrap secrets          | See above — `HARNESS_ADMINS` / `HARNESS_SESSION_SECRET` / `HARNESS_CURSOR_SECRET`, fetched from SSM at cold start, never a Lambda env var                                            |
| SSM: public base URL            | See above — `PUBLIC_BASE_URL_SSM_PARAM`, written after Web deploys; session URLs fall back, viewer Origin checks fail closed until readable                                          |
| CloudFront ingress secret       | See above — Secrets Manager secret auto-generated by the Runtime stack (not SSM, not operator-provisioned); backs `x-auto-harness-ingress-token` for the REST REQUEST authorizer     |
| `HARNESS_SLACK_APP_SSM_PARAM`   | Optional SSM `SecureString` name containing OAuth `{clientId,clientSecret,signingSecret}`; REST only, manual Slack setup does not require it                                         |
| Table names / prefix            | From stack (see [aws.md](aws.md) env table)                                                                                                                                          |
| `ARCHIVE_BUCKET`                | S3 archive bucket (REST and Cron only — WebSocket does not write archives)                                                                                                           |
| `WS_API_ENDPOINT`               | API Gateway Management API for `postToConnection`                                                                                                                                    |
| `KMS_KEY_ID`                    | REST and Cron only — Slack, custom-webhook, and GitHub ingress webhook secrets. WebSocket does not receive the key or decrypt grants                                                 |
| `HARNESS_METRIC_ENVIRONMENT`    | Table prefix used as the CloudWatch `Environment` dimension for operational EMF metrics                                                                                              |
| Rate-limit variables            | `HARNESS_RATE_LIMIT_*`, `HARNESS_WS_RATE_LIMIT_PER_SECOND`, and `HARNESS_RATE_LIMIT_FAIL_MODE`; see [security.md](security.md#rate-limiting)                                         |
| `HARNESS_HYDRATE_CATALOGS`      | REST only — `false` so cold start does not Scan catalogs. Cron and WebSocket omit this and still hydrate catalogs (not session history)                                              |
| `HARNESS_API_SENTRY_DSN`        | Optional. When set, REST, WebSocket, and Cron Lambdas send unhandled errors to Sentry. Omitted from Lambda env when unset. Not an SSM secret.                                        |
| `HARNESS_WEB_SENTRY_DSN_CLIENT` | Optional. Browser Sentry DSN for the control-plane UI. Injected at request time; changing it does not require rebuilding the web image. Events POST to same-origin `/sentry-tunnel`. |
| `HARNESS_WEB_SENTRY_DSN_SERVER` | Optional. Next.js server Sentry DSN for the web Lambda. Distinct from the client DSN so browser and server projects can stay separate.                                               |

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

| Variable                             | Required             | Purpose                                                                                                                                                                                                            |
| ------------------------------------ | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `HARNESS_DEPLOY_ENVIRONMENT`         | Always               | Isolates stack, table, bucket, and SSM names                                                                                                                                                                       |
| `AWS_REGION` or `AWS_DEFAULT_REGION` | One required         | AWS deployment region                                                                                                                                                                                              |
| `HARNESS_DEPLOY_REMOVAL_POLICY`      | No; default `retain` | `retain` for durable data or `destroy` for disposable data                                                                                                                                                         |
| `AWS_ACCOUNT_ID`                     | No                   | Avoids the STS account lookup when already known                                                                                                                                                                   |
| `HARNESS_DEPLOY_CONFIRM`             | Teardown/purge only  | Must exactly match `HARNESS_DEPLOY_ENVIRONMENT`                                                                                                                                                                    |
| `HARNESS_DEPLOY_PURGE_CONFIRM`       | Purge only           | Must exactly match `destroy-all-data-in-<environment>`                                                                                                                                                             |
| `HARNESS_DEPLOY_PURGE_SSM`           | No; default off      | Set to `1` to also delete the four bootstrap/public-base-url SSM parameters; the optional Slack app parameter is always retained                                                                                   |
| `HARNESS_ACCESS_LOGS_ENABLED`        | No; default off      | Set to exactly `1` to enable redacted HTTP/WS access logs (see below)                                                                                                                                              |
| `HARNESS_API_SENTRY_DSN`             | No                   | Optional Sentry DSN for REST/WebSocket/Cron Lambdas. Invalid non-empty values fail deploy.                                                                                                                         |
| `HARNESS_WEB_SENTRY_DSN_CLIENT`      | No                   | Optional browser Sentry DSN for the CloudFront UI                                                                                                                                                                  |
| `HARNESS_WEB_SENTRY_DSN_SERVER`      | No                   | Optional Next.js server Sentry DSN for the web Lambda                                                                                                                                                              |
| `HARNESS_DEPLOY_ALARM_EMAILS`        | No; default none     | Comma-separated addresses to subscribe to the alarm topic. Malformed addresses fail deploy. The topic and every alarm action are created either way — see [observability.md](observability.md#alarm-notifications) |

The generated names are `AutoHarness-<environment>-Foundation`,
`AutoHarness-<environment>-Runtime`, `AutoHarness-<environment>-Web`, and
`AutoHarness-<environment>-*` for tables.
The names are generic and do not depend on any repository connected later in the UI.

### API Gateway access logs (opt-in)

Redacted HTTP/WS access logs (`services/cdk/src/runtime-observability.ts`) are
off by default. They require `stage.accessLogSettings`, which in turn requires
an `AWS::ApiGateway::Account` resource — a **one-time, AWS-account-wide
singleton** (one per account/region, shared by every stack and every repo
deployed into that account) that points API Gateway at an IAM role with
the required CloudWatch Logs permissions. `deploy`/`update` never provision it,
and the account-level bootstrap below is a hard prerequisite, not a graceful
fallback: the CDK code does not check whether the account is already
bootstrapped, so setting `HARNESS_ACCESS_LOGS_ENABLED=1` before running it
still synthesizes the log groups and `AccessLogSettings`, and the deployment
itself then fails (or rolls back) because API Gateway rejects
`AccessLogSettings` on an account with no CloudWatch Logs role configured.

Provision it once per account, before the first environment that wants access
logs:

```bash
pnpm bootstrap:apigateway-account
```

This runs a separate, environment-independent CDK app
(`services/cdk/src/apigateway-account-cli.ts` /
`apigateway-account-stack.ts`) that creates the IAM role and the
`AWS::ApiGateway::Account` resource, and (via `cdk bootstrap`) the shared
`CDKToolkit` stack if this account/region doesn't already have one. No
application stack in the account is touched. Both the role and the account
resource are deployed with `RemovalPolicy.RETAIN`, so destroying this
bootstrap stack never clears the account-wide setting out from under an
unrelated stack or repo running in the same account. Re-running the script is
a harmless no-op.

After that succeeds, opt individual environments into access logs:

```bash
HARNESS_ACCESS_LOGS_ENABLED=1 pnpm deploy:aws
```

Only the literal string `1` opts in; any other value (including `true`) keeps
access logs off. Throttles, CloudWatch alarms, and app-emitted operational EMF
metrics are unaffected either way — they don't depend on the account-level
role.

## Deploy a new environment

```bash
pnpm install
export AWS_REGION=us-west-2
export HARNESS_DEPLOY_ENVIRONMENT=production
pnpm --filter @auto-harness/cdk run deploy
```

`deploy` refuses to run if any application stack already exists, verifies the
three SSM parameters, bootstraps CDK in the selected account and region, deploys
all three stacks, calls `/health` through the public CloudFront `WebUrl`, loads the hosted `/login`
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

From the repository root, the normal update is one command. It defaults to the `production`
environment in `us-west-2`, fast-forwards a clean `main` checkout, installs locked dependencies,
updates all stacks, and runs the existing CloudFront API/web health checks:

```bash
pnpm deploy:aws
```

Set `HARNESS_DEPLOY_ENVIRONMENT`, `AWS_REGION` (or `AWS_DEFAULT_REGION`), removal policy, and SSM
overrides before invoking it when the target differs. The lower-level
`pnpm --filter @auto-harness/cdk run update` remains available for recovery and development flows
that must deploy the current checkout without synchronizing `main`.

`update` requires the foundation stack, applies the current CDK app to all three
stacks, and runs the CloudFront API and web health checks. It also recreates missing runtime
or web stacks after a retained teardown.

### First rollout of the principal session-drain ledger

`pnpm deploy:aws` detects this rollout from the missing environment-scoped activity-ledger readiness
marker, disables and fences the old scheduler, asks for one confirmation that external admission is
disabled, waits out the old REST and WebSocket functions' configured invocation timeouts, and then
verifies there are no drain-affecting sessions. It performs the update, runs the new bounded
migration driver while scheduling remains fenced, verifies the marker, and restores the EventBridge
rule's original enabled or disabled state. In non-interactive automation, pass
`--yes-first-ledger` only after disabling external admission; the command still performs its own
writer wait and post-fence active-session verification:

```bash
pnpm deploy:aws -- --yes-first-ledger
```

The command also sets the scheduler Lambda's reserved concurrency to zero, verifies that fence,
and waits for the function's configured invocation timeout before updating. It restores the prior
concurrency setting only after the update succeeds; failures leave both scheduler gates closed for
fail-closed recovery.

The first revision containing the principal session-drain activity ledger
requires a writer fence. Before running `update`, stop external session
admission and disable the environment's EventBridge cron rule. Wait for in-flight
REST, WebSocket, and cron Lambda invocations to finish, then keep that gate in
place while `update` replaces every runtime writer. After `update` completes, the
deployment process writes the ledger readiness marker directly for an empty
Sessions table. REST and WebSocket cold starts never scan session history. REST also skips
catalog/worktree/connection/archive Scans (`HARNESS_HYDRATE_CATALOGS=false`) so a
host-inventory GET is a `GetItem` and cannot 500 behind init hydrate; drain admission
fails closed while the marker is absent. The wrapper verifies the `SessionDrains`
table contains `scopeKey=__session-drain-ledger__` and
`recordKey=ACTIVITY-V1`, restores the rule's original state, and only then permits
external admission to be re-enabled.

Do not allow old and new runtime writers to overlap this bootstrap: an old warm
Lambda does not write activity members and could otherwise admit a session after
the readiness marker was published. This gate is required only for the first
ledger rollout; later revisions all participate in the same transactional member
protocol.

### First rollout of priority-ordered session listing

The priority-list revision uses the same maintenance fence. It adds
`statusShard-priorityOrder`, waits until DynamoDB reports it `ACTIVE`, then adds
`statusShard-repositoryPriorityOrder` in a second Foundation update and waits
again. It then adds `statusShard-createdOrder`, whose `createdAt#id` range key
matches the REST creation-time tie-breaker. DynamoDB permits only one GSI create
per update of an existing table. Only after all three indexes are queryable does
the wrapper deploy the runtime and write the readiness marker directly for an
empty Sessions table. Its durable readiness marker is `SessionDrains`
`scopeKey=__session-priority-order__`, `recordKey=READY-V2`.

For non-interactive deployment, keep external session admission disabled and
provide the explicit maintenance acknowledgement:

```bash
pnpm deploy:aws -- --yes-priority-order
```

The wrapper refuses to restore scheduler admission if the marker is absent.

### Fresh environment cutover for breaking coordination schemas

The sparse active-host claim index and later attempt/transcript protocol changes are a fresh
environment cutover, not an in-place runtime update. The active-host reader deliberately has no
historical scan fallback, and local table startup rejects an absent or still-building index.

1. Export the current environment's supported configuration and retained data.
2. Pause external admission, drain every confirmed running assignment, and manually resolve any
   execution whose outcome is ambiguous.
3. Deploy a fresh foundation and its matching control-plane and host-daemon versions. Do not let
   old and new writers share a Sessions table.
4. Validate assignment, acknowledgement, reconnect recovery, terminal cleanup, and transcript
   reads in the new environment before switching callers.
5. Keep the previous environment intact and admission-paused until the new environment has passed
   validation and the rollback window has closed.

An in-place migration requires a separate bounded, resumable backfill plus a durable readiness
marker before readers switch. This repository does not currently provide that migration, so adding
the GSI to an old Sessions table is not sufficient.

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

`removalPolicy` accepts only `retain` (the default) or `destroy`. `retain`
enables DynamoDB deletion protection; `destroy` leaves it off so disposable
tables can be removed. Point-in-time recovery is on for every table in either
policy. With `destroy`, CloudFormation still cannot remove a non-empty archive
bucket; empty it explicitly before deleting the stack. The foundation
deliberately does not enable CDK `autoDeleteObjects`, because that feature adds
a custom-resource Lambda and would exceed this stack's no-runtime-resources
boundary. Do not choose `destroy` for data that must survive a stack replacement.

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
the environment's configured policy (this also turns off DynamoDB deletion
protection), empties the archive bucket (including
noncurrent versions and delete markers — `aws s3 rm --recursive` alone is not
enough for a versioned bucket, and `cdk destroy` fails with `BucketNotEmpty`
otherwise), then destroys the foundation stack. It verifies afterward that no
application stack survives.

### Purge and a Sessions table behind on indexes

Originally, the retarget step was a full `cdk deploy` of the foundation that synthesized the
**complete** current table template — including all eight Sessions GSIs — passing
`sessionPriorityIndexStage=both` and `sessionCreatedOrderIndexStage=status`, which defer
nothing. Against `AutoHarness-production-Foundation` on 2026-09-16, whose Sessions table had
3 of 8 indexes, CloudFormation rejected that update with the same limit that caused the
2026-09-08 outage this command was supposed to remedy:

```
UPDATE_FAILED  Sessions8896A56D
"Cannot perform more than one GSI creation or deletion in a single update"
```

Purge no longer synthesizes the retarget from the catalog. Before touching anything, it
calls `inspectLiveTables` (`deployment-purge-schema.ts`), which `describe-table`s every
catalog table and returns each existing table's **live** GSI names. The retarget
(`retargetFoundationForDeletion`) passes that per-table allowlist to the foundation stack
as `-c existingGsiNamesByTable=<json>`, and `stagedTables()` (`foundation-stack.ts`) filters
each table's synthesized GSIs down to exactly that live set. A table this drifted therefore
synthesizes with only the indexes it already has, so the retarget changes no indexes at
all — only the DeletionPolicy flip (and, for a retain-policy environment,
`DeletionProtectionEnabled: false`) — regardless of how many indexes it's missing or which
table they're on. This is a true no-op for CloudFormation only insofar as its stored
template already agrees with the live table's GSI set (true of the reproduced production
case: CloudFormation was rejecting the same 3-of-8 update DynamoDB itself was enforcing); a
stack template that has independently drifted from the table it describes is not something
this inspects.

`inspectLiveTables` also fails closed as a pre-flight check, before web and runtime are
destroyed: DynamoDB refuses **any** `UpdateTable` — even one that only flips
`DeletionProtectionEnabled` — while a table or any of its GSIs isn't `ACTIVE` (exactly the
state an interrupted staged index rollout leaves behind). Purge now refuses up front in that
case, converting what used to be a torn-down-but-undeletable environment (web and runtime
already destroyed, foundation retarget doomed to fail) into a clean refusal that leaves
everything standing. This only proves the retarget isn't blocked by a resource in
transition — it doesn't prove the retarget will otherwise succeed.

To check an environment's Sessions index drift by hand:

```bash
aws dynamodb describe-table --table-name "AutoHarness-<environment>-Sessions" \
  --query "Table.GlobalSecondaryIndexes[].[IndexName,IndexStatus]" --output text
```

The alternative — `aws cloudformation delete-stack` — does not help on its own: the
live template still carries `DeletionPolicy: Retain`, so it orphans the tables, archive
bucket, and KMS key under their existing names, which then collide with the next
`deploy` of the same environment name.

### Purge and a table retired from the catalog

This is a `retain`-removal-policy problem in general, not a one-off about any single
table: any environment deployed with `HARNESS_DEPLOY_REMOVAL_POLICY=retain` (the
default, and what production uses) keeps `DeletionPolicy: Retain` on every table in its
live CloudFormation template regardless of what the _current_ `services/cdk/src/tables.ts`
catalog says. If a table is later retired from that catalog — `SessionLogs` was, once log
bodies moved to S3 (see [aws.md](aws.md), "There is no SessionLogs table") — the
foundation stack's own template still has it. Retiring a table from any `retain`-policy
environment's catalog will reproduce this.

Against `AutoHarness-production-Foundation` on 2026-09-16, purge's retarget step
(`retargetFoundationForDeletion`) synthesized the current catalog, which no longer
included `SessionLogs`, so its `cdk deploy` removed that resource from the stack.
Because `DeletionPolicy` was still `Retain` at that moment, CloudFormation emitted:

```
AutoHarness-production-Foundation | 33/35 | DELETE_SKIPPED | AWS::DynamoDB::Table | SessionLogsABAF303F
```

— which orphaned the live table (954 items, deletion protection enabled) outside
CloudFormation's management entirely. The later `cdk destroy` of the stack never saw it,
because it was no longer stack-managed, so purge exited 0 and reported success with the
table still live.

Purge now detects this before it happens: before the retarget runs, it calls
`findOrphanedTableNames` (`deployment-purge-orphans.ts`), which reads the foundation
stack's **own stored template** — `aws cloudformation get-template --template-stage
Original` — and diffs its `AWS::DynamoDB::Table` resources against the current catalog.
Anything present in the stack's own template but absent from the catalog is captured in
memory as an orphan-to-be. This deliberately does **not** list every table matching
`${config.tablePrefix}-` and filter by prefix: table prefixes are
`AutoHarness-${environment}`, so environment `prod` prefix-matches
`AutoHarness-prod-extra-Sessions`, a table belonging to a _different_ environment
(`prod-extra`). A prefix scan could misidentify and delete another environment's live
data; reading only the one stack's own stored template makes that misattribution
structurally impossible.

The captured list is carried through in memory — not re-derived — across the retarget and
the foundation stack's destroy, because `get-template` stops working for a stack once it
no longer exists, and because the retarget's own `cdk deploy` rewrites the stack's stored
template to no longer mention the dropped resource at all (`--template-stage Original`
always reflects the _currently deployed_ template). After the foundation stack is
destroyed, purge disables deletion protection on each captured orphan
(`update-table --no-deletion-protection-enabled`, tolerating the table already having
been deleted by the retarget itself if its `DeletionPolicy` happened to be `Delete`),
waits for it to settle back to `ACTIVE`, and deletes it, reporting each one by name. If
any orphan survives, purge throws naming exactly which ones — it never reports success
while one is still live.

Two things purge deliberately does **not** finish immediately:

- **The integration KMS key** enters AWS's seven-day pending-deletion window —
  CloudFormation can only schedule deletion; seven days is the AWS minimum, and
  the key is not actually gone until that window elapses.
- **The four bootstrap/public-base-url SSM parameters** (the three bootstrap
  secrets, hand-managed outside CDK and possibly shared with another environment,
  plus the deploy-script-managed public base URL) are left in place unless
  `HARNESS_DEPLOY_PURGE_SSM=1` is also set — deleting any of them is never implied
  by the rest of purge. The optional `HARNESS_SLACK_APP_SSM_PARAM` is also left in
  place even when that opt-in is set because it may be shared and has no separate
  purge confirmation.

One thing purge does not finish **at all**: each runtime/web Lambda now
provisions its own `AWS::Logs::LogGroup` **stack resource** with
`RemovalPolicy.RETAIN` (see `functionLogGroup` in `runtime-stack.ts` and
`webFunctionLogGroup` in `web-stack.ts`) — unlike the environment's tables,
archive bucket, and KMS key, these are never retargeted to
`DeletionPolicy: Delete` before their stack is destroyed, so `cdk destroy`
orphans them instead of removing them. Because neither `functionName` nor
`logGroupName` is pinned, each group's physical name is CDK-generated, **not**
the conventional `/aws/lambda/<function>` — search for orphaned groups by
CloudFormation logical ID prefix (`RestFunctionLogGroup`,
`WebSocketFunctionLogGroup`, `CronFunctionLogGroup`, `WebFunctionLogGroup`) or
by tag/creation-time, not by an `/aws/lambda/...` name prefix. Their 14-day
retention only stops new events from accumulating — the (now-empty) group
itself is not deleted and remains until removed manually.

Similarly, when access logs were ever enabled (`HARNESS_ACCESS_LOGS_ENABLED=1`),
purge does not delete the two `HttpAccessLogs`/`WebSocketAccessLogs` CloudWatch
log groups either: same mechanism as above (see
`services/cdk/src/runtime-observability.ts`'s `accessLogGroup` helper), so
`cdk destroy` orphans them instead of removing them. Same as the function log
groups above, their 14-day retention only stops new events from accumulating —
the empty group itself is not deleted and remains until removed manually.

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

| Output                                                      | Consumer                                                                                                                                                     |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `TablePrefix`; `UsersTableName` through `CommandsTableName` | Current storage naming / future API configuration                                                                                                            |
| `ArchiveBucketName`, `ArchiveBucketArn`                     | Future archival runtime configuration                                                                                                                        |
| `ApiDataAccessPolicyArn`, `ArchiveDataAccessPolicyArn`      | Runtime Lambda attachments: all three get the DynamoDB policy; REST and Cron get archive PutObject, while REST alone gets archive GetObject/GetObjectVersion |
| `IntegrationKeyArn`                                         | Foundation-owned integration encryption                                                                                                                      |
| `RestApiUrl`, `WebSocketUrl`                                | Debugging only — direct REST ingress is origin-protected; **not** a value to hand to a host daemon; see below                                                |
| `WebUrl`                                                    | Browser control-plane URL **and** the value to set as `HARNESS_API_URL` on every host daemon                                                                 |

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

## Custom domain and TLS (not supported today)

There is no custom-domain or ACM-certificate support in `services/cdk` today.
`AutoHarnessWebStack` (`services/cdk/src/web-stack.ts`) constructs its
`cloudfront.Distribution` with no `domainNames` and no `certificate` prop, so every
environment gets CloudFront's default `*.cloudfront.net` hostname and certificate.
Nothing in `services/cdk/src` references `domainNames`, a CloudFront `certificate`, or
`aws-certificatemanager` — there is no flag, CDK context value, or code path anywhere in
this package that attaches an operator-owned domain or an ACM certificate to that
distribution.

`WebUrl` (see [Stack parameters and outputs](#stack-parameters-and-outputs) above) is
that raw CloudFront domain, and it is the value every host daemon's `HARNESS_API_URL`
must be set to (`services/host-daemon/src/ws-url.ts` explicitly rejects the raw API
Gateway hostnames for the same reason CloudFront is required at all: one hostname has to
front both the REST and WebSocket APIs). It is also the URL an operator bookmarks and
signs into. Until custom-domain support exists, that means:

- No operator-branded hostname for the browser control plane or for `HARNESS_API_URL` —
  everyone is on a CloudFront-assigned domain.
- Anyone standing this up for real users should expect the deployed URL to look like
  `https://d111111abcdef8.cloudfront.net`, not a domain they chose.
- Attaching a custom domain would require, at minimum, an ACM certificate issued in
  `us-east-1` (CloudFront's requirement regardless of the stack's own deployment region),
  a `domainNames`/`certificate` pair on the `Distribution`, and DNS pointed at it — none
  of which exists in this repository yet. This is a real gap for anyone who needs a
  stable, brandable URL, not a documentation oversight; treat it as a feature to design,
  not a missing flag to flip.

---

## Gates

| When                           | Gate                                                                             |
| ------------------------------ | -------------------------------------------------------------------------------- |
| Before merge                   | `pnpm --filter @auto-harness/cdk synth` and deterministic synthesis tests        |
| Before an AWS deployment claim | Deploy, update, CloudFront API/web health checks, and teardown in an AWS account |

[qa-production.md](qa-production.md) is the copy-pasteable script for the second row —
restore or deploy through a real programmatic session to purge, with the traps that
aren't obvious from this doc alone. Laptop-only counterpart: [qa-local.md](qa-local.md).

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
