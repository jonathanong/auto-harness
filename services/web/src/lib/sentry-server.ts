import { optionalSentryDsn, scrubSentryEvent } from "@auto-harness/shared";
import * as Sentry from "@sentry/nextjs";

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
