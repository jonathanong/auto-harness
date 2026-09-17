import type { Instrumentation } from "next";

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "edge") return;
  const { initHostPaneSentryServer } = await import("./lib/sentry-server.ts");
  initHostPaneSentryServer();
}

/**
 * Next 15+/16's hook for server-component/route-handler errors -- see the near-identical
 * export in services/web/src/instrumentation.ts for the full rationale.
 */
export const onRequestError: Instrumentation.onRequestError = async (
  error,
  request,
  errorContext,
) => {
  if (process.env.NEXT_RUNTIME === "edge") return;
  const { captureHostPaneRequestError } = await import("./lib/sentry-server.ts");
  await captureHostPaneRequestError(error, request, errorContext);
};
