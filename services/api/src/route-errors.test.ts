import { afterEach, describe, expect, it, vi } from "vitest";

import {
  captureSentryException,
  initApiSentry,
  resetApiSentryForTests,
  type SentryClient,
} from "./sentry.ts";
import { reportRouteError } from "./route-errors.ts";

function fakeSentry(): SentryClient & { captured: unknown[] } {
  const captured: unknown[] = [];
  return {
    captured,
    captureException: (error, hint) => {
      captured.push({ error, hint });
    },
    flush: vi.fn(async () => true),
    init: vi.fn(),
  };
}

afterEach(() => {
  resetApiSentryForTests();
});

describe("reportRouteError", () => {
  it("logs the structured stderr shape restUnhandledError uses", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const error = new Error("storage unavailable");

    reportRouteError({
      error,
      method: "GET",
      url: new URL("http://127.0.0.1/api/v1/hosts?online=true"),
    });

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [logged] = errorSpy.mock.calls[0] as [string];
    expect(JSON.parse(logged)).toEqual({
      msg: "route failure",
      method: "GET",
      path: "/api/v1/hosts",
      error: "storage unavailable",
    });
    errorSpy.mockRestore();
  });

  it("uses a caller-supplied msg to keep per-route CloudWatch queries greppable", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    reportRouteError({
      error: new Error("boom"),
      method: "POST",
      url: new URL("http://127.0.0.1/api/v1/hosts/drain"),
      msg: "host-scheduler route failure",
    });

    const [logged] = errorSpy.mock.calls[0] as [string];
    expect((JSON.parse(logged) as { msg: string }).msg).toBe("host-scheduler route failure");
    errorSpy.mockRestore();
  });

  it("never logs the query string, even when it carries something sensitive", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    reportRouteError({
      error: new Error("boom"),
      method: "GET",
      url: new URL("http://127.0.0.1/api/v1/hosts?apiKey=super-secret&cookie=session-token"),
    });

    const [logged] = errorSpy.mock.calls[0] as [string];
    expect(logged).not.toContain("super-secret");
    expect(logged).not.toContain("session-token");
    expect(logged).not.toContain("apiKey");
    errorSpy.mockRestore();
  });

  it("reports to Sentry, tagged as rest, only once a DSN is configured", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const sentry = fakeSentry();

    // No DSN: captureSentryException stays a documented no-op (see sentry.ts), so this
    // module does not need its own DSN gating.
    reportRouteError({ error: new Error("boom"), method: "GET", url: new URL("http://x/y") });
    expect(sentry.captured).toEqual([]);

    initApiSentry({ HARNESS_API_SENTRY_DSN: "https://abc123@o1.ingest.sentry.io/450" }, sentry);
    const error = new Error("storage unavailable");
    reportRouteError({ error, method: "GET", url: new URL("http://127.0.0.1/api/v1/hosts") });
    expect(sentry.captured).toEqual([{ error, hint: { tags: { runtime: "rest" } } }]);
    // This module never flushes -- see the WHY comment on reportRouteError. Flushing is
    // lambda-handlers.ts's REST wrapper's job, once per invocation.
    expect(sentry.flush).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("delegates to the real captureSentryException rather than duplicating its logic", () => {
    // Guards against route-errors.ts growing its own Sentry client/DSN handling instead
    // of reusing sentry.ts, which is the single source of truth for that behavior.
    const sentry = fakeSentry();
    initApiSentry({ HARNESS_API_SENTRY_DSN: "https://abc123@o1.ingest.sentry.io/450" }, sentry);
    const error = new Error("boom");
    captureSentryException(error, "rest");
    expect(sentry.captured).toEqual([{ error, hint: { tags: { runtime: "rest" } } }]);
  });
});
