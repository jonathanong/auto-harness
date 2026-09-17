import { optionalSentryDsn, scrubSentryEvent } from "@auto-harness/shared";
import * as Sentry from "@sentry/nextjs";
import type { Instrumentation } from "next";

export function initWebSentryServer(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const dsn = optionalSentryDsn(env.HARNESS_WEB_SENTRY_DSN_SERVER);
  if (!dsn) return false;
  Sentry.init({
    beforeSend: scrubSentryEvent,
    dsn,
    environment: env.HARNESS_DEPLOY_ENVIRONMENT?.trim() || "local",
    initialScope: { tags: { plane: "web", runtime: "server" } },
    sendDefaultPii: false,
    tracesSampleRate: 0,
  });
  return true;
}

/**
 * Wired to instrumentation.ts's `onRequestError` export -- the Next.js 15+/16 hook through
 * which server-component and route-handler errors reach Sentry (Next calls this itself; see
 * `@sentry/nextjs`'s `captureRequestError`, built for exactly this hook).
 *
 * Explicitly DSN-gated, matching `initWebSentryServer`, rather than relying on
 * `captureRequestError`'s own no-client no-op (calling `Sentry.captureException` with no
 * `Sentry.init` call is itself a documented no-op) -- that keeps "nothing happens without a
 * DSN" provable by mocking this module directly, rather than depending on an SDK internal.
 *
 * Awaits a flush the way `route-errors.ts` explicitly avoids for API route handlers, and for
 * the same reason `lambda-handlers.ts`'s `restUnhandledError` does flush: this *is* the
 * terminal boundary for a Next request-level error, `services/web` ships as a
 * `DockerImageFunction` (see docs/observability.md), and Lambda can freeze the execution
 * environment as soon as this hook's returned promise settles. `captureRequestError`'s own
 * internal flush (`waitUntil(flushSafelyWithTimeout())`) resolves to a Vercel/Cloudflare
 * `waitUntil` that is a no-op off those platforms, so nothing else guarantees the event is
 * actually sent before that freeze.
 */
export async function captureWebRequestError(
  error: unknown,
  request: Parameters<Instrumentation.onRequestError>[1],
  errorContext: Parameters<Instrumentation.onRequestError>[2],
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  if (!optionalSentryDsn(env.HARNESS_WEB_SENTRY_DSN_SERVER)) return;
  Sentry.captureRequestError(error, request, errorContext);
  await Sentry.flush(2_000);
}
