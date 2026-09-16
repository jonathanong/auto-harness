import { thrownMessage } from "@auto-harness/shared";

import { captureSentryException } from "./sentry.ts";

/**
 * Everything a route is allowed to log about the request it was handling. Method and
 * pathname only — never the query string, body, cookies, or an authorization/API-key
 * header, any of which `url` or the request may otherwise carry.
 */
export type RouteErrorContext = {
  error: unknown;
  method: string;
  url: URL;
  /** Route-specific prefix so a CloudWatch query can filter to one surface. Defaults to a generic tag. */
  msg?: string;
};

/**
 * The one place a route failure caught inside a handler gets reported. Every
 * `sendInternalError`/ad-hoc-500 call site in local-routes-*.ts funnels here instead of
 * swallowing the error, so a storage or IAM failure always leaves the same structured
 * CloudWatch line `lambda-handlers.ts`'s `restUnhandledError` leaves for errors that
 * escape all the way to the top — same shape, different origin.
 *
 * No overlap with `restUnhandledError`: this function never throws, so a route that
 * calls it (directly or via `sendInternalError`) already sent its response and returns
 * normally — the error never reaches the handler's outer try/catch in local-app.ts, let
 * alone escapes to the Lambda entry point. The two report disjoint sets of errors.
 *
 * No flush here, deliberately. `captureSentryException` only queues the event on the
 * client; Sentry's transport sends it in the background without the caller waiting.
 * `flushSentryIfCaptured` forces that send and blocks for up to its timeout, which is the
 * right thing to do once per Lambda invocation right before the response returns (see
 * `restUnhandledError` and the cron/websocket wrappers in lambda-handlers.ts) but wrong
 * to call from inside a route handler: every one of the ~69 call sites would then pay
 * that latency on its own failure, worst during an incident when many requests fail
 * together -- exactly when added latency compounds. lambda-handlers.ts's REST wrapper
 * flushes once after building the response, covering captures from this module too;
 * `flushSentryIfCaptured` no-ops when nothing was captured, so that costs nothing on the
 * (overwhelmingly common) success path.
 */
export function reportRouteError(context: RouteErrorContext): void {
  const { error, method, url, msg = "route failure" } = context;
  console.error(JSON.stringify({ msg, method, path: url.pathname, error: thrownMessage(error) }));
  captureSentryException(error, "rest");
}
