import { afterEach, describe, expect, it, vi } from "vitest";

import {
  captureSentryException,
  flushSentryIfCaptured,
  initApiSentry,
  reportApiCrash,
  resetApiSentryForTests,
  type SentryClient,
} from "./sentry.ts";

const dsn = "https://abc123@o1.ingest.sentry.io/450";

function fakeSentry(): SentryClient & { inits: unknown[]; captured: unknown[] } {
  const inits: unknown[] = [];
  const captured: unknown[] = [];
  return {
    captured,
    captureException: (error, hint) => {
      captured.push({ error, hint });
    },
    flush: vi.fn(async () => true),
    init: (options) => {
      inits.push(options);
    },
    inits,
  };
}

afterEach(() => {
  resetApiSentryForTests();
});

describe("initApiSentry", () => {
  it("does not init without a DSN and does not flush on the success path", async () => {
    const sentry = fakeSentry();
    expect(initApiSentry({}, sentry)).toBe(false);
    expect(sentry.inits).toEqual([]);
    captureSentryException(new Error("ignored"), "rest");
    await flushSentryIfCaptured();
    expect(sentry.captured).toEqual([]);
    expect(sentry.flush).not.toHaveBeenCalled();
  });

  it("captures and flushes only after an error when a DSN is set", async () => {
    const sentry = fakeSentry();
    expect(
      initApiSentry({ HARNESS_API_SENTRY_DSN: dsn, HARNESS_DEPLOY_ENVIRONMENT: "qa" }, sentry),
    ).toBe(true);
    const options = sentry.inits[0] as {
      beforeSend: (event: { request?: { headers?: Record<string, string> } }) => unknown;
      integrations: (defaults: Array<{ name: string }>) => Array<{ name: string }>;
    };
    expect(sentry.inits[0]).toMatchObject({
      dsn,
      environment: "qa",
      sendDefaultPii: false,
      tracesSampleRate: 0,
    });
    expect(
      options.integrations([{ name: "OnUncaughtException" }, { name: "Http" }]).map((i) => i.name),
    ).toEqual(["Http"]);
    expect(
      options.beforeSend({ request: { headers: { Cookie: "x", Accept: "text/plain" } } }),
    ).toEqual({ request: { headers: { Accept: "text/plain" } } });
    const error = new Error("boom");
    captureSentryException(error, "rest");
    expect(sentry.captured).toEqual([{ error, hint: { tags: { runtime: "rest" } } }]);
    await flushSentryIfCaptured();
    expect(sentry.flush).toHaveBeenCalledWith(2_000);
    await flushSentryIfCaptured();
    expect(sentry.flush).toHaveBeenCalledTimes(1);
  });

  it("reportApiCrash captures a local crash and flushes", async () => {
    const sentry = fakeSentry();
    initApiSentry({ HARNESS_API_SENTRY_DSN: dsn }, sentry);
    const error = new Error("crash");
    await reportApiCrash(error);
    expect(sentry.captured).toEqual([{ error, hint: { tags: { runtime: "local" } } }]);
    expect(sentry.flush).toHaveBeenCalledOnce();
  });
});
