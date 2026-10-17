import { afterEach, describe, expect, it } from "vitest";

import { retryDelayMs } from "../actions/dispatch/src/retry.ts";
import {
  closeDispatchActionServers,
  drain,
  drainInputs,
  runAction,
  serve,
} from "./test-helpers/dispatch-action-test-helpers.ts";

afterEach(closeDispatchActionServers);

const session = {
  created: true,
  concurrencyId: "github-42",
  id: "session-1",
  target: { providerId: "codex" },
  url: "https://example.test/sessions/session-1",
};

const dispatchInputs = (origin: string, concurrencyId = "github-42") => ({
  ...drainInputs(origin, "dispatch"),
  ...(concurrencyId ? { "concurrency-id": concurrencyId } : {}),
  prompt: "review",
  target: '{"providerId":"codex"}',
  timeout: "300",
});

describe("dispatch action transient-failure retry", () => {
  it("retries a dispatch once after a 503 and succeeds", async () => {
    const server = await serve((request) =>
      server.requests.indexOf(request) === 0
        ? { body: { error: { message: "warming up" } }, status: 503 }
        : { body: session },
    );

    const result = await runAction(dispatchInputs(server.origin));

    expect(result.code).toBe(0);
    expect(server.requests).toHaveLength(2);
    expect(server.requests[1]?.body).toBe(server.requests[0]?.body);
    expect(result.output["session-id"]).toBe("session-1");
  });

  it("retries a resume once after a dropped connection and succeeds", async () => {
    const server = await serve((request) =>
      server.requests.indexOf(request) === 0
        ? { body: null, destroy: true }
        : { body: { ...session, created: false } },
    );

    const result = await runAction({
      "api-key": "test-key",
      operation: "resume",
      "concurrency-id": "github-42",
      "server-url": server.origin,
      "session-id": "session-1",
    });

    expect(result.code).toBe(0);
    expect(server.requests).toHaveLength(2);
    expect(result.output.created).toBe("false");
  });

  it("honors Retry-After before the retry", async () => {
    const started: number[] = [];
    const server = await serve(() => {
      started.push(Date.now());
      return started.length === 1
        ? { body: {}, headers: { "retry-after": "1" }, status: 429 }
        : { body: session };
    });

    const result = await runAction(dispatchInputs(server.origin));

    expect(result.code).toBe(0);
    expect(started).toHaveLength(2);
    expect(started[1]! - started[0]!).toBeGreaterThanOrEqual(950);
  });

  it("retries a timed-out dispatch once with a fresh request budget", async () => {
    const server = await serve(() => ({ body: session, delayMs: 300 }));

    const result = await runAction({
      ...dispatchInputs(server.origin),
      "request-timeout-seconds": "0.1",
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/Timed out waiting for Auto Harness request/);
    expect(server.requests).toHaveLength(2);
  });

  it("retries a 429 even without a concurrency-id", async () => {
    const server = await serve((request) =>
      server.requests.indexOf(request) === 0
        ? { body: {}, headers: { "retry-after": "0" }, status: 429 }
        : { body: session },
    );

    const result = await runAction(dispatchInputs(server.origin, ""));

    expect(result.code).toBe(0);
    expect(server.requests).toHaveLength(2);
  });

  it("does not retry an ambiguous 503 dispatch without a concurrency-id", async () => {
    const server = await serve(() => ({ body: { error: { message: "busy" } }, status: 503 }));

    const result = await runAction(dispatchInputs(server.origin, ""));

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Auto Harness returned 503: busy");
    expect(server.requests).toHaveLength(1);
  });

  it("does not retry a dropped resume connection without a concurrency-id", async () => {
    const server = await serve(() => ({ body: null, destroy: true }));

    const result = await runAction({
      "api-key": "test-key",
      operation: "resume",
      "server-url": server.origin,
      "session-id": "session-1",
    });

    expect(result.code).toBe(1);
    expect(server.requests).toHaveLength(1);
  });

  it.each([400, 401, 404, 409])("does not retry an HTTP %s", async (status) => {
    const server = await serve(() => ({ body: { error: { message: "nope" } }, status }));

    const result = await runAction(dispatchInputs(server.origin));

    expect(result.code).toBe(1);
    expect(server.requests).toHaveLength(1);
  });

  it("fails after the second attempt and reports the server message", async () => {
    const server = await serve(() => ({
      body: { error: { message: "database\n::warning::unavailable" } },
      status: 502,
    }));

    const result = await runAction(dispatchInputs(server.origin));

    expect(result.code).toBe(1);
    expect(server.requests).toHaveLength(2);
    expect(result.stderr).toContain(
      "::error::Auto Harness returned 502: database%0A::warning::unavailable",
    );
  });

  it("does not retry drain operations", async () => {
    const server = await serve(() => ({ body: drain("succeeded"), status: 503 }));

    const result = await runAction({
      ...drainInputs(server.origin, "get-drain"),
      "session-drain-id": "drain-1",
    });

    expect(result.code).toBe(1);
    expect(server.requests).toHaveLength(1);
  });
});

describe("dispatch action retry delay", () => {
  it.each([
    [undefined, 500],
    ["", 500],
    ["2", 2_000],
    [" 0 ", 0],
    ["soon", 500],
    ["3600", 60_000],
    ["Thu, 01 Jan 1970 00:00:03 GMT", 2_000],
    ["Thu, 01 Jan 1970 00:00:00 GMT", 0],
  ])("maps Retry-After %j to %i ms", (retryAfter, expected) => {
    expect(retryDelayMs(retryAfter, 1_000)).toBe(expected);
  });
});
