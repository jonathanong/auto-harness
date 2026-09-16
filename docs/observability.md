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
| `AckTimeouts`                  | Yes     | `AckTimeouts` ≥ 1                  | Cron: a host failed to ACK an assignment before timeout                                                                            |
| `AssignmentFailures`           | Yes     | `AssignmentFailures` ≥ 1           | `postToConnection` failed for a reason other than a gone socket                                                                    |
| `InfrastructureRetries`        | No      | metric-only                        | A bounded checkout-fetch or pre-launch host-loss retry committed — expected recovery, not a failure                                |
| `InfrastructureRetryExhausted` | Yes     | `InfrastructureRetryExhausted` ≥ 1 | The invocation committing the terminal transition exhausted the one-retry budget                                                   |
| `Cooldowns`                    | Yes     | `Cooldowns` ≥ 1                    | A `usage_limit` paused a Provider Account                                                                                          |
| `LogDrops`                     | Yes     | `LogDrops` ≥ 1                     | Persisted `session:log.dropped` telemetry (legacy in-memory/test WS path only — host-pane SSE/gzip part ingest does not emit this) |
| `LogSeqGaps`                   | Yes     | `LogSeqGaps` ≥ 1                   | Transcript lines missing, detected from a discontinuity in the agent-assigned `seq` — silent loss the ingest pipeline caused       |
| `StaleAttemptLogDrops`         | No      | metric-only                        | A log message discarded because its attempt was already superseded, while its batch-mates still committed                          |
| `QueueAgeSeconds`              | Yes     | **`QueueAge`** ≥ 1800 (30 min)     | Age of the oldest `queued` session — note the alarm's construct ID does not match the metric name                                  |
| `StaleHosts`                   | Yes     | `StaleHosts` ≥ 1                   | Cron found hosts that stopped reporting                                                                                            |
| `WsMessagesDiscarded`          | No      | metric-only                        | A host WebSocket message dropped because the connection was being closed (rate limit, invalid frame, stale/unauthorized)           |

3 of the 11 are metrics-only by design (`InfrastructureRetries`, `StaleAttemptLogDrops`,
`WsMessagesDiscarded`) — expected during ordinary reconnects/recovery, not alarmed.

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
`web`/`host-pane` client and server) sets `tracesSampleRate: 0` — no performance/tracing data — and
`sendDefaultPii: false`. `scrubSentryEvent` (`modules/shared/src/sentry-dsn.ts`) additionally
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
plausibly still reach Sentry via the SDK's own default handlers — see Known gaps for what's
missing on the Next.js server side.

## Known gaps

- **All CloudWatch alarms have no alarm action.** `grep -rn "Topic|SnsAction|addAlarmAction|aws-sns" services/cdk/src/`
  returns nothing — there is no SNS topic anywhere in `services/cdk/`. Every alarm above changes
  state and notifies nobody; there is no page, email, or Slack hook. This is a deliberate,
  deferred decision, not a bug — surfacing it here, not fixing it.
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
- **Next.js server-side errors likely never reach Sentry via `onRequestError`.**
  `grep -rn "onRequestError|captureRequestError"` across the repo returns nothing. Neither
  `services/web/src/instrumentation.ts` nor `services/host-pane/src/instrumentation.ts` exports
  anything but `register()`. The installed `@sentry/nextjs@10.74.0` does export
  `captureRequestError` (confirmed in its type declarations), which Next 15+/16 calls via the
  `onRequestError` hook to route server-component and route-handler errors to an error monitor —
  without that hook wired up, those errors are not forwarded. This is scoped narrowly: neither
  Next server init strips Sentry's default `OnUncaughtException`/`OnUnhandledRejection`
  integrations (unlike the API/host-daemon inits), so a raw Node process crash in `web` or
  `host-pane` plausibly still reaches Sentry through the SDK's own handlers — what's specifically
  missing is the hook for errors Next itself catches and renders. **Likely — not empirically
  confirmed against a running deployment.**
- **No sourcemap upload or release tracking.** Neither `next.config.ts` (`services/web`,
  `services/host-pane`) wraps its config in `withSentryConfig`, and
  `SENTRY_AUTH_TOKEN`/`SENTRY_ORG`/`SENTRY_PROJECT`/`SENTRY_RELEASE` appear nowhere in the repo.
  The web app ships as a `DockerImageFunction`, so any upload step would have to live in the
  Docker build — it isn't there either. Consequence: Sentry events carry minified/unsymbolicated
  browser stack traces with no release or commit association. (The API/Cron/WebSocket Lambda
  bundling does set `sourceMap: true` in `runtime-stack.ts`, but that's local esbuild output for
  stack-trace readability in CloudWatch Logs, not a Sentry release upload — no auth token or
  org/project is configured for Node either.)
- **`services/api/src/local-app.ts`'s last-resort request handler never calls
  `captureSentryException`.** The catch block at lines 283–291 logs via `console.error` only; the
  file has no Sentry import at all. Its Lambda twin, `handleRestEvent`'s catch in
  `services/api/src/lambda-handlers.ts:866`, calls `captureSentryException(error, "rest")`. So a
  route exception under `pnpm local:api` or the Docker API reaches container stdout logs but never
  Sentry — even when `HARNESS_API_SENTRY_DSN` is set. This is narrower than a dead local Sentry
  integration: `cli.ts` wires `installCrashLogging({ report: reportApiCrash })`, so an actual
  process crash (uncaught exception / unhandled rejection) under `pnpm local:api` **does** reach
  Sentry — only in-request route errors that `local-app.ts` catches and turns into a 500 are
  invisible to it.
- **Silent 500s.** Beyond the local-app.ts gap above, some route handlers elsewhere catch an error
  and return a 500 without logging it at all, so the failure never reaches CloudWatch either —
  Sentry and structured logs both miss it. This is a pattern to watch for in review, not a single
  known site: one instance recently cost a live IAM-policy read to diagnose. A related file is
  being edited concurrently by another agent as this page is written, so its current state isn't
  asserted here.

## Related

| Doc                                                               | Content                                            |
| ----------------------------------------------------------------- | -------------------------------------------------- |
| [aws.md](aws.md#observability)                                    | Alarm/metric source table, throttle values         |
| [deploy-aws.md](deploy-aws.md#api-gateway-access-logs-opt-in)     | DSN env var tables, access-log bootstrap steps     |
| [local-development.md](local-development.md#optional-sentry-dsns) | Local Sentry DSN table, local ports                |
| [deploy-host-daemon.md](deploy-host-daemon.md)                    | `HARNESS_HOST_SENTRY_DSN` install/persist behavior |
| [web.md](web.md)                                                  | Web/host-pane Sentry DSN vars, tunnel/CSP note     |
