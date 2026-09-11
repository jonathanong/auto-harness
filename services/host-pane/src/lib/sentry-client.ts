import { scrubSentryEvent, SENTRY_TUNNEL_PATH } from "@auto-harness/shared";
import * as Sentry from "@sentry/nextjs";

export function initBrowserSentry(dsn: string): void {
  Sentry.init({
    beforeSend: scrubSentryEvent,
    dsn,
    environment: process.env.NODE_ENV === "production" ? "production" : "local",
    initialScope: { tags: { plane: "host-pane", runtime: "client" } },
    sendDefaultPii: false,
    tracesSampleRate: 0,
    tunnel: SENTRY_TUNNEL_PATH,
  });
}

export function reportClientError(error: unknown): void {
  Sentry.captureException(error);
}
