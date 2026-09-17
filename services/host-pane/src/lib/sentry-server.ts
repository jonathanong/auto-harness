import { optionalSentryDsn, scrubSentryEvent } from "@auto-harness/shared";
import * as Sentry from "@sentry/nextjs";
import type { Instrumentation } from "next";

export function initHostPaneSentryServer(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const dsn = optionalSentryDsn(env.HARNESS_HOST_PANE_SENTRY_DSN_SERVER);
  if (!dsn) return false;
  Sentry.init({
    beforeSend: scrubSentryEvent,
    dsn,
    environment: env.HARNESS_DEPLOY_ENVIRONMENT?.trim() || "local",
    initialScope: { tags: { plane: "host-pane", runtime: "server" } },
    sendDefaultPii: false,
    tracesSampleRate: 0,
  });
  return true;
}

/**
 * Wired to instrumentation.ts's `onRequestError` export -- see the near-identical
 * `captureWebRequestError` in services/web/src/lib/sentry-server.ts for the full rationale
 * (DSN-gated for testability, flush awaited so the event isn't lost to a frozen execution
 * environment). Host-pane is never deployed to AWS (it runs only as `pnpm local:host-pane`,
 * a long-lived local process), so the flush is cheap insurance here rather than a fix for a
 * live freezing risk -- kept for parity with services/web rather than because host-pane
 * itself needs it.
 */
export async function captureHostPaneRequestError(
  error: unknown,
  request: Parameters<Instrumentation.onRequestError>[1],
  errorContext: Parameters<Instrumentation.onRequestError>[2],
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  if (!optionalSentryDsn(env.HARNESS_HOST_PANE_SENTRY_DSN_SERVER)) return;
  Sentry.captureRequestError(error, request, errorContext);
  await Sentry.flush(2_000);
}
