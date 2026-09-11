import { optionalSentryDsn, scrubSentryEvent } from "@auto-harness/shared";
import * as Sentry from "@sentry/node";

export type SentryRuntime = "rest" | "websocket" | "cron" | "local";

export type SentryClient = {
  captureException: (error: unknown, hint?: { tags?: Record<string, string> }) => void;
  flush: (timeout: number) => Promise<boolean>;
  init: (options: Record<string, unknown>) => void;
};

let client: SentryClient = Sentry;
let enabled = false;
let pending = false;

export function resetApiSentryForTests(next: SentryClient = Sentry): void {
  client = next;
  enabled = false;
  pending = false;
}

export function initApiSentry(
  env: Record<string, string | undefined> = process.env,
  sentry: SentryClient = client,
): boolean {
  client = sentry;
  const dsn = optionalSentryDsn(env.HARNESS_API_SENTRY_DSN);
  if (!dsn) {
    enabled = false;
    return false;
  }
  client.init({
    beforeSend: scrubSentryEvent,
    dsn,
    environment: env.HARNESS_DEPLOY_ENVIRONMENT?.trim() || "local",
    initialScope: { tags: { plane: "api" } },
    integrations: (defaults: Array<{ name: string }>) =>
      defaults.filter(
        (integration) =>
          integration.name !== "OnUncaughtException" && integration.name !== "OnUnhandledRejection",
      ),
    sendDefaultPii: false,
    tracesSampleRate: 0,
  });
  enabled = true;
  return true;
}

export function captureSentryException(error: unknown, runtime: SentryRuntime): void {
  if (!enabled) return;
  pending = true;
  client.captureException(error, { tags: { runtime } });
}

export async function flushSentryIfCaptured(timeoutMs = 2_000): Promise<void> {
  if (!enabled || !pending) return;
  pending = false;
  await client.flush(timeoutMs);
}

export async function reportApiCrash(error: unknown): Promise<void> {
  captureSentryException(error, "local");
  await flushSentryIfCaptured();
}
