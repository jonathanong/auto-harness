# Observability

Single page for "how do I know something is broken, and where do I look." Mechanics live in
[aws.md](aws.md#observability) and [deploy-aws.md](deploy-aws.md); this page is the operator view
across CloudWatch and Sentry.

## Signal table

11 EMF operational metrics are defined in `services/api/src/operational-metrics.ts`, namespace
`AutoHarness`, dimension `Environment` = the table prefix (`AutoHarness-<environment>`, **not**
the bare environment name — e.g. `AutoHarness-production`). `emitOperationalMetric` no-ops when
`HARNESS_METRIC_ENVIRONMENT` is unset, so the local stand-in never emits EMF metrics; only the
deployed Lambdas set that var (`runtime-stack.ts`, to `props.tablePrefix`).

| EMF metric                     | Alarmed | Alarm construct ID / threshold     | Meaning                                                                                                                            |
| ------------------------------ | ------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `AckTimeouts`                  | No      | metric-only                        | Cron: a host failed to ACK an assignment before timeout                                                                            |
| `AssignmentFailures`           | No      | metric-only                        | `postToConnection` failed for a reason other than a gone socket                                                                    |
| `InfrastructureRetries`        | No      | metric-only                        | A bounded checkout-fetch or pre-launch host-loss retry committed — expected recovery, not a failure                                |
| `InfrastructureRetryExhausted` | Yes     | `InfrastructureRetryExhausted` ≥ 1 | The invocation committing the terminal transition exhausted the one-retry budget                                                   |
| `Cooldowns`                    | No      | metric-only                        | A `usage_limit` paused a Provider Account                                                                                          |
| `LogDrops`                     | No      | metric-only                        | Persisted `session:log.dropped` telemetry (legacy in-memory/test WS path only — host-pane SSE/gzip part ingest does not emit this) |
| `LogSeqGaps`                   | No      | metric-only                        | Transcript lines missing, detected from a discontinuity in the agent-assigned `seq` — silent loss the ingest pipeline caused       |
| `StaleAttemptLogDrops`         | No      | metric-only                        | A log message discarded because its attempt was already superseded, while its batch-mates still committed                          |
| `QueueAgeSeconds`              | Yes     | **`QueueAge`** ≥ 1800 (30 min)     | Age of the oldest `queued` session — note the alarm's construct ID does not match the metric name                                  |
| `StaleHosts`                   | No      | metric-only                        | Cron found hosts that stopped reporting                                                                                            |
| `WsMessagesDiscarded`          | No      | metric-only                        | A host WebSocket message dropped because the connection was being closed (rate limit, invalid frame, stale/unauthorized)           |

9 of the 11 are metrics-only: successful bounded recovery signals and events designed to
recover automatically remain visible without paging. Only `InfrastructureRetryExhausted` and
`QueueAge` have operational metric alarms.

Alongside these, `services/cdk/src/runtime-observability.ts` also alarms on AWS-native metrics
(not EMF, no `Environment` dimension):

| Alarm construct ID        | Source                                              | Threshold |
| ------------------------- | --------------------------------------------------- | --------- |
| `RestFunctionErrors`      | REST Lambda `AWS/Lambda` `Errors`                   | ≥ 1       |
| `WebSocketFunctionErrors` | WebSocket Lambda `AWS/Lambda` `Errors`              | ≥ 1       |
| `CronFunctionErrors`      | Cron Lambda `AWS/Lambda` `Errors`                   | ≥ 1       |
| `HttpApi5xx`              | HTTP API `AWS/ApiGateway` `5xx`                     | ≥ 1       |
| `WebSocketApiErrors`      | WebSocket API `IntegrationError` + `ExecutionError` | ≥ 1       |

All alarms use a 5-minute period, 1 evaluation period, 1 datapoint to alarm, and
`treatMissingData: NOT_BREACHING`.

## CloudWatch

- **Function logs.** Each Lambda (`RestFunction`, `WebSocketFunction`, `CronFunction`,
  `WebFunction`) gets its own `AWS::Logs::LogGroup` construct with 14-day retention and
  `RemovalPolicy.RETAIN`. Since neither `functionName` nor `logGroupName` is pinned, the physical
  log group name is CDK-generated, not the conventional `/aws/lambda/<function>` — find it by
  CloudFormation logical ID prefix (`RestFunctionLogGroup`, `WebSocketFunctionLogGroup`,
  `CronFunctionLogGroup`, `WebFunctionLogGroup`) or by tag/creation time.
- **RETAIN, not DESTROY.** `cdk destroy` (via teardown/purge) orphans these log groups instead of
  removing them — 14-day retention only stops new events from accumulating; the empty group stays
  until removed manually. See [deploy-aws.md §Purge](deploy-aws.md#purge-irreversible) for the
  full consequence and how to find orphaned groups.
- **Access logs (opt-in, off by default).** `HARNESS_ACCESS_LOGS_ENABLED=1` adds redacted
  HTTP/WebSocket access logs (request id, route, status, latency fields, source IP — never query
  strings, headers, or bodies) to their own 14-day, `RemovalPolicy.RETAIN` log groups
  (`HttpAccessLogs` / `WebSocketAccessLogs`). They require a **one-time, account-level API Gateway
  CloudWatch Logs role** (`pnpm bootstrap:apigateway-account`) that `deploy`/`update` never
  provision — enabling the flag before bootstrapping fails the deployment. See
  [deploy-aws.md §API Gateway access logs](deploy-aws.md#api-gateway-access-logs-opt-in).
- Stage throttles (HTTP 100 req/s burst 200; WebSocket 250 msg/s burst 500) apply unconditionally,
  independent of access logs or alarms.

## Sentry

Six DSN env vars, one per surface/runtime pair. Everything is **off unless a DSN is set** —
`optionalSentryDsn` treats unset, blank, and placeholder values (`REPLACE_WITH...`,
`<...>`, `${...}`) as off.

| Variable                              | Surface / runtime                                        | Injected by                                                                                                                  |
| ------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `HARNESS_API_SENTRY_DSN`              | API — REST/WebSocket/Cron Lambdas (and `pnpm local:api`) | `runtime-stack.ts` `commonEnvironment`, validated in `deployment-config.ts`                                                  |
| `HARNESS_WEB_SENTRY_DSN_CLIENT`       | Web — browser                                            | `web-stack.ts`, validated in `deployment-config.ts`                                                                          |
| `HARNESS_WEB_SENTRY_DSN_SERVER`       | Web — Next.js server (Lambda)                            | `web-stack.ts`, validated in `deployment-config.ts`                                                                          |
| `HARNESS_HOST_SENTRY_DSN`             | Host daemon process                                      | `install-service` persists it (`host-service-env-persisted.ts`); no CDK deploy path — the daemon runs on the VPS, not in AWS |
| `HARNESS_HOST_PANE_SENTRY_DSN_CLIENT` | Host pane — browser                                      | Process env only (`pnpm local:host-pane`) — **no deploy or persist path**, see Known gaps                                    |
| `HARNESS_HOST_PANE_SENTRY_DSN_SERVER` | Host pane — Next.js server                               | Process env only — **no deploy or persist path**, see Known gaps                                                             |

**Invalid non-empty DSNs fail the deploy** for the three CDK-managed vars
(`HARNESS_API_SENTRY_DSN`, `HARNESS_WEB_SENTRY_DSN_CLIENT`, `HARNESS_WEB_SENTRY_DSN_SERVER`):
`deploymentConfig`'s `optionalDsn` throws via `inspectSentryDsn` when a non-empty value doesn't
parse as `https://<key>@<host>/<project>`. At runtime, every init site instead just no-ops on an
invalid DSN and keeps serving — deploy fails closed, running processes stay up.

**Same-origin tunnel.** Browser Sentry (`initBrowserSentry` in both `services/web/src/lib/sentry-client.ts`
and `services/host-pane/src/lib/sentry-client.ts`) sets `tunnel: SENTRY_TUNNEL_PATH`
(`/sentry-tunnel`, `modules/shared/src/sentry-tunnel.ts`) instead of letting the SDK POST directly
to `*.ingest.sentry.io`. The app's own `/sentry-tunnel` route re-parses the envelope's DSN header,
confirms it matches the server's configured client DSN, and forwards only to that DSN's ingest
URL — a closed proxy, not an open relay. This is why CSP `connect-src` never needs
`*.ingest.sentry.io` in either app.

**Errors only.** Every init (`api/src/sentry.ts`, `host-daemon/src/sentry.ts`,
`web`/`host-pane` client and server) sets `tracesSampleRate: 0` — no performance/tracing data.
API and host-daemon still set `sendDefaultPii: false`. Web and host-pane set `dataCollection`
to the v10-restrictive baseline (no PII widening). `scrubSentryEvent` (`modules/shared/src/sentry-dsn.ts`) additionally
strips `cookie`/`authorization` request headers from every event via `beforeSend`.

**Crash handling ownership.** The two Node server inits (`api/src/sentry.ts`,
`host-daemon/src/sentry.ts`) deliberately filter Sentry's default integrations to drop
`OnUncaughtException`/`OnUnhandledRejection` — `Sentry.init`'s `integrations` callback excludes
those two by name. This is so `installCrashLogging` (`modules/shared/src/process-lifecycle.ts`) is
the **single owner** of process-level crash handling: it logs synchronously, then always calls
`process.exit(1)`, matching Node's own guidance that resuming after either event is unsafe. If
Sentry's own handlers were left in, two independent listeners would race to decide the process's
fate. `installCrashLogging`'s `report` hook (wired to `reportApiCrash` / `reportHostCrash` in each
service's `cli.ts`) gets a best-effort **2-second** window (`reportTimeoutMs`, default `2_000`) to
flush the captured exception to Sentry via `Promise.race` against a timer — whichever finishes
first, the process exits `1` regardless of whether the Sentry flush actually completed. A slow or
unreachable Sentry ingest endpoint can silently lose the crash report; the exit itself is never
delayed by it. The browser and Next.js-server inits do **not** filter these integrations (they
have no equivalent single-owner crash path), so Node process crashes in `web`/`host-pane`
plausibly still reach Sentry via the SDK's own default handlers.

**Next.js request errors.** Errors Next itself catches and renders (server-component and
route-handler errors) reach Sentry through each app's `onRequestError` export in
`instrumentation.ts`, wired to `captureWebRequestError`/`captureHostPaneRequestError` in
`lib/sentry-server.ts`. Both call the installed `@sentry/nextjs` 11's `captureRequestError`
(the function Next 15+/16 documents this hook for) and then explicitly `await Sentry.flush(2_000)`
— `captureRequestError`'s own internal flush is a Vercel/Cloudflare `waitUntil` that no-ops off
those platforms, and `services/web` ships as a Lambda `DockerImageFunction`, so nothing else would
guarantee delivery before the execution environment freezes. Both are DSN-gated the same way
`initWebSentryServer`/`initHostPaneSentryServer` are, so this stays a no-op with no DSN set.

This covers the **Node runtime only**. Both `onRequestError` exports return early when
`NEXT_RUNTIME === "edge"`, mirroring `register()`: neither app initializes Sentry on the edge
runtime, so there would be no client for a captured error to reach. No route in either app opts
into the edge runtime today, so nothing is currently unreported — but a route that does would
have its server errors silently skipped until `register()` initializes Sentry there too.

## Alarm notifications

Alarms are **opt-in**. By default the runtime stack creates no CloudWatch alarms, SNS topic, or
`AlarmTopicArn` output. Set `HARNESS_DEPLOY_ALARMS=true` or supply one or more addresses in
`HARNESS_DEPLOY_ALARM_EMAILS` to create the seven retained alarms and one shared topic. Email
addresses take effect at deploy time; SNS requires recipients to confirm each email
subscription. A malformed address fails the deploy rather than being silently dropped.

The seven alarms are `RestFunctionErrors`, `WebSocketFunctionErrors`, `CronFunctionErrors`,
`HttpApi5xx`, `WebSocketApiErrors`, `QueueAge`, and `InfrastructureRetryExhausted`. All route to
the shared topic. The WebSocket API math alarm references two metrics, so this set uses eight
standard alarm metrics in total (six single-metric alarms plus two inputs to one expression).
At $0.10 per standard alarm metric, that is approximately **$0.80/month** before applicable
CloudWatch allowances; actual pricing depends on account/region and current
[CloudWatch pricing](https://aws.amazon.com/cloudwatch/pricing/).

If alarms are enabled, the topic's **`AlarmTopicArn`** output lets operators add a manual
subscription without changing code:

```bash
aws sns subscribe --topic-arn "$(aws cloudformation describe-stacks \
  --stack-name "AutoHarness-${ENV}-Runtime" \
  --query 'Stacks[0].Outputs[?OutputKey==`AlarmTopicArn`].OutputValue' --output text)" \
  --protocol email --notification-endpoint you@example.com
```

Existing environments that use a manually subscribed topic must set
`HARNESS_DEPLOY_ALARMS=true` on every deploy/update. Without the flag or an email list, a stack
update removes the topic, alarms, and output; enabling alarms later recreates them, but the
former topic ARN and its manual subscriptions do not carry over. EMF metric publication remains
independent and continues whether or not alarms are enabled.

Two deliberate limits:

- **Alarm actions only, no OK actions.** Every alarm pairs `treatMissingData: NOT_BREACHING`
  with a single datapoint over one period, so a sparse `Sum` metric returns to OK on the next
  period. OK actions would roughly double the volume to report that a one-off spike had stopped.
  Recovery stays visible in the alarm's own history.
- **The topic is not KMS-encrypted.** A notification carries metric metadata only — alarm name,
  namespace, metric, threshold, state transition, timestamp — and no session, repository, or
  credential content. CloudWatch cannot publish through the AWS-managed `alias/aws/sns` key
  because that key's policy cannot be edited, so encrypting would require a customer-managed
  key, and every `pnpm purge` would drop one into a 7–30 day deletion window. `enforceSSL` still
  denies any publish attempted over plaintext HTTP. Revisit if the topic ever carries a payload.

## Known gaps

- **Nothing is monitored by default.** Set `HARNESS_DEPLOY_ALARMS=true` or configure
  `HARNESS_DEPLOY_ALARM_EMAILS` to provision alarms and their notification topic before treating
  an environment as monitored.
- **`HARNESS_HOST_PANE_SENTRY_DSN_CLIENT` / `_SERVER` have no deploy or persist path.** Neither
  var appears anywhere in `services/cdk/` (`DeploymentConfig` only has `apiSentryDsn`,
  `webSentryDsnClient`, `webSentryDsnServer`), and neither is in the persisted-env allowlist in
  `services/host-daemon/src/host-service-env-persisted.ts` (which lists only
  `HARNESS_HOST_SENTRY_DSN`). Host-pane reads them straight from `process.env`
  (`services/host-pane/src/app/layout.tsx`, `lib/sentry-server.ts`), so they work under
  `pnpm local:host-pane` but cannot be set in any deployed environment. Low impact — host-pane is
  debug-only and never deployed to AWS (see the repo invariant) — but the local-development.md
  table lists these vars alongside the other four as if they have equivalent reach, which they
  don't.
- **Host-pane installation remains operator-owned.** `pnpm sentry:sourcemaps host-pane` builds
  the exact local production artifact, uploads its maps under the immutable Git release, and
  deletes the maps. This repository still has no command that installs or restarts a persistent
  host-pane server, so the operator must run that artifact through the existing host-local
  service boundary. The AWS control-plane web path has no such gap: `pnpm deploy:aws` performs
  the upload inside its exact Docker image build when `HARNESS_SENTRY_ENABLED=1`.
- **Silent 500s.** Some route handlers catch an error and return a 500 without logging it at all,
  so the failure never reaches CloudWatch either — Sentry and structured logs both miss it. This
  is a pattern to watch for in review, not a single known site: one instance recently cost a live
  IAM-policy read to diagnose. A related file is being edited concurrently by another agent as
  this page is written, so its current state isn't asserted here.

## Related

| Doc                                                               | Content                                            |
| ----------------------------------------------------------------- | -------------------------------------------------- |
| [aws.md](aws.md#observability)                                    | Alarm/metric source table, throttle values         |
| [deploy-aws.md](deploy-aws.md#api-gateway-access-logs-opt-in)     | DSN env var tables, access-log bootstrap steps     |
| [local-development.md](local-development.md#optional-sentry-dsns) | Local Sentry DSN table, local ports                |
| [deploy-host-daemon.md](deploy-host-daemon.md)                    | `HARNESS_HOST_SENTRY_DSN` install/persist behavior |
| [web.md](web.md)                                                  | Web/host-pane Sentry DSN vars, tunnel/CSP note     |
