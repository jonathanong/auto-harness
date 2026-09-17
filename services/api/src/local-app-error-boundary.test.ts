import { afterEach, describe, expect, it, vi } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { createLocalApp } from "./local-server.ts";
import { initApiSentry, resetApiSentryForTests, type SentryClient } from "./sentry.ts";
import { invokeHandler } from "../test-helpers/local-server-test-helpers.ts";

/**
 * Route modules catch their own IO, but anything escaping one used to reject the floated
 * promise in createServer's callback. Node turns that into process exit, so a single
 * unguarded throw took the API down and left the client waiting on a silent socket.
 *
 * A malformed request line is the cheapest way to reach that: `new URL(req.url, base)`
 * runs before any route is chosen, so it sits outside every per-route try/catch.
 */
const MALFORMED_URL = "http://[";

function app() {
  return createLocalApp({ plane: new ControlPlane(), rateLimitConfig: { enabled: false } });
}

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

describe("local app error boundary", () => {
  afterEach(() => {
    resetApiSentryForTests();
  });

  it("answers 500 to a malformed request URL instead of rejecting to the process", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { handler } = app();

    const res = await invokeHandler(handler, "GET", MALFORMED_URL);

    expect(res.status).toBe(500);
    expect(res.json).toMatchObject({ error: { code: "INTERNAL_ERROR" } });
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });

  it("does not log request-derived text, which can carry credentials or control characters", async () => {
    const messages: string[] = [];
    const errors = vi.spyOn(console, "error").mockImplementation((message: unknown) => {
      messages.push(String(message));
    });
    const { handler } = app();

    await invokeHandler(handler, "GET", `${MALFORMED_URL}?ticket=super-secret`);

    expect(messages).toEqual(["unhandled request error"]);
    expect(messages.join("\n")).not.toContain(MALFORMED_URL);
    expect(messages.join("\n")).not.toContain("super-secret");
    errors.mockRestore();
  });

  it("does not write a second response when headers were already sent", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { handler } = app();
    const req = {
      method: "GET",
      url: MALFORMED_URL,
      headers: {},
      on() {
        return req;
      },
    };
    const writes: number[] = [];
    const res = {
      headersSent: true,
      setHeader() {},
      writeHead(code: number) {
        writes.push(code);
      },
      end() {},
    };
    await handler(req as never, res as never);
    expect(writes).toEqual([]);
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });

  it("still serves normal requests", async () => {
    const { handler } = app();

    expect((await invokeHandler(handler, "GET", "/health")).status).toBe(200);
  });

  it("reports the escaping error to Sentry when a DSN is configured", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const sentry = fakeSentry();
    initApiSentry({ HARNESS_API_SENTRY_DSN: "https://abc123@o1.ingest.sentry.io/450" }, sentry);
    const { handler } = app();

    const res = await invokeHandler(handler, "GET", MALFORMED_URL);

    expect(res.status).toBe(500);
    expect(sentry.captured).toEqual([
      { error: expect.any(Error), hint: { tags: { runtime: "rest" } } },
    ]);
    // Deliberately no flush here -- see the WHY comment on local-app.ts's handler: the Lambda
    // REST wrapper flushes once after building its response, and the local/Docker process
    // doesn't need a synchronous flush at all.
    expect(sentry.flush).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it("does not attempt to report anything to Sentry when no DSN is configured", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const sentry = fakeSentry();
    // No DSN passed -- initApiSentry returns false and leaves capture disabled, matching
    // production behavior when HARNESS_API_SENTRY_DSN is unset.
    expect(initApiSentry({}, sentry)).toBe(false);
    const { handler } = app();

    const res = await invokeHandler(handler, "GET", MALFORMED_URL);

    expect(res.status).toBe(500);
    expect(sentry.captured).toEqual([]);
    expect(sentry.flush).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});
