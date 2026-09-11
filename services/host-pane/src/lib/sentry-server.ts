import { optionalSentryDsn, scrubSentryEvent } from "@auto-harness/shared";
import * as Sentry from "@sentry/nextjs";

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
