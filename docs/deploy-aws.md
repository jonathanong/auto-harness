# Deploy — AWS control plane

**Foundation available.** `services/cdk` can synthesize DynamoDB tables, the S3
log-archive bucket, and unassigned least-privilege IAM policies. API Gateway,
Lambda, WebSocket, EventBridge, and runtime deployment are still design work.
Architecture: [aws.md](aws.md).

Ops index: [deploy.md](deploy.md). Local stack: [deploy-local.md](deploy-local.md). VPS agent: [deploy-host-daemon.md](deploy-host-daemon.md).

---

## Maturity

| Item                         | Status                                                            |
| ---------------------------- | ----------------------------------------------------------------- |
| Design / data model          | Documented in [aws.md](aws.md)                                    |
| CDK package (`services/cdk`) | Synthesizable persistence foundation                              |
| Runtime deployment           | Not implemented; there is deliberately no package `deploy` script |

Do not treat a successful synth as an AWS deployment claim. It validates the
CloudFormation shape only.

---

## Prerequisites (for synthesis)

- Node ≥22.18 and pnpm
- `pnpm install` from the repository root (the CDK CLI is a package development dependency)

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

## Synthesize the foundation

```bash
pnpm install
pnpm --filter @auto-harness/cdk synth
```

The default stack is `AutoHarnessFoundation`, creates tables named
`AutoHarness-*`, and retains all data resources on replacement and deletion.
Use CDK context to create a deliberately named disposable environment:

```bash
pnpm --filter @auto-harness/cdk synth -- \
  -c tablePrefix=Review20 \
  -c archiveBucketName=review-20-cdk-foundation-archives \
  -c removalPolicy=destroy
```

`removalPolicy` accepts only `retain` (the default) or `destroy`. With
`destroy`, CloudFormation still cannot remove a non-empty archive bucket; empty
it explicitly before deleting the stack. The foundation deliberately does not
enable CDK `autoDeleteObjects`, because that feature adds a custom-resource
Lambda and would exceed this stack's no-runtime-resources boundary. Do not
choose `destroy` for data that must survive a stack replacement.

### Foundation outputs

| Output                                                      | Consumer                                          |
| ----------------------------------------------------------- | ------------------------------------------------- |
| `TablePrefix`; `UsersTableName` through `CommandsTableName` | Current storage naming / future API configuration |
| `ArchiveBucketName`, `ArchiveBucketArn`                     | Future archival runtime configuration             |
| `ApiDataAccessPolicyArn`, `ArchiveDataAccessPolicyArn`      | Future runtime-role attachments                   |

There is no `RestApiUrl`, `WebSocketUrl`, or `Region` output yet because those
runtime resources are outside this foundation.

---

## Future deployment boundary

Before adding deployment, introduce the runtime resources and deployment
runbook together: bootstrap requirements, an explicit deploy command, runtime
roles, endpoint outputs, and an account-backed smoke test. This foundation does
not authorize or imply any of those operations.

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
