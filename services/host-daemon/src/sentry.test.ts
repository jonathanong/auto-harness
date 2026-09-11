import { afterEach, describe, expect, it, vi } from "vitest";

import {
  captureSentryException,
  flushSentryIfCaptured,
  initHostSentry,
  reportHostCrash,
  resetHostSentryForTests,
  type SentryClient,
} from "./sentry.ts";

const dsn = "https://abc123@o1.ingest.sentry.io/450";

function fakeSentry(): SentryClient & { inits: unknown[]; captured: unknown[] } {
  const inits: unknown[] = [];
  const captured: unknown[] = [];
  return {
    captured,
    captureException: (error) => {
      captured.push(error);
    },
    flush: vi.fn(async () => true),
    init: (options) => {
      inits.push(options);
    },
    inits,
  };
}

afterEach(() => {
  resetHostSentryForTests();
});

describe("initHostSentry", () => {
  it("does nothing without a DSN", async () => {
    const sentry = fakeSentry();
    expect(initHostSentry({}, sentry)).toBe(false);
    captureSentryException(new Error("ignored"));
    await flushSentryIfCaptured();
    expect(sentry.inits).toEqual([]);
    expect(sentry.captured).toEqual([]);
  });

  it("omits hostId when identity is not set", () => {
    const sentry = fakeSentry();
    expect(initHostSentry({ HARNESS_HOST_SENTRY_DSN: dsn }, sentry)).toBe(true);
    expect(sentry.inits[0]).toMatchObject({
      initialScope: { tags: { plane: "host-daemon", runtime: "server" } },
    });
    expect(
      (sentry.inits[0] as { initialScope: { tags: Record<string, string> } }).initialScope.tags
        .hostId,
    ).toBeUndefined();
  });

  it("tags the host id and flushes a crash report", async () => {
    const sentry = fakeSentry();
    expect(
      initHostSentry({ HARNESS_HOST_SENTRY_DSN: dsn, HARNESS_HOST_ID: "host-1" }, sentry),
    ).toBe(true);
    const options = sentry.inits[0] as {
      integrations: (defaults: Array<{ name: string }>) => Array<{ name: string }>;
    };
    expect(sentry.inits[0]).toMatchObject({
      dsn,
      initialScope: { tags: { plane: "host-daemon", runtime: "server", hostId: "host-1" } },
    });
    expect(
      options.integrations([{ name: "OnUnhandledRejection" }, { name: "Http" }]).map((i) => i.name),
    ).toEqual(["Http"]);
    const error = new Error("boom");
    await reportHostCrash(error);
    expect(sentry.captured).toEqual([error]);
    expect(sentry.flush).toHaveBeenCalledWith(2_000);
  });
});
