import type { Instrumentation } from "next";

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "edge") return;
  const { initWebSentryServer } = await import("./lib/sentry-server.ts");
  initWebSentryServer();
}

/**
 * Next 15+/16's hook for server-component/route-handler errors -- distinct from `register()`,
 * which only initializes the SDK. Without this export, `Sentry.init` still runs (via
 * `register()`) but nothing ever calls `Sentry.captureException` for an error Next itself
 * catches and renders, so those errors never reach Sentry even with a DSN configured.
 *
 * Skips the edge runtime for the same reason `register()` does: this app never initializes
 * Sentry there, so there is nothing for `captureWebRequestError` to report either -- not
 * because the hook itself would misbehave on edge.
 */
export const onRequestError: Instrumentation.onRequestError = async (
  error,
  request,
  errorContext,
) => {
  if (process.env.NEXT_RUNTIME === "edge") return;
  const { captureWebRequestError } = await import("./lib/sentry-server.ts");
  await captureWebRequestError(error, request, errorContext);
};
