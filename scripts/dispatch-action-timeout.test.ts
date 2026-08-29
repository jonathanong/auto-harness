import { afterEach, describe, expect, it } from "vitest";

import {
  closeDispatchActionServers,
  drain,
  drainInputs,
  runAction,
  serve,
} from "./dispatch-action-test-helpers.ts";

afterEach(closeDispatchActionServers);

describe("dispatch action request timeouts", () => {
  it("accepts the maximum request timeout", async () => {
    const server = await serve(() => ({ body: drain("succeeded") }));

    const result = await runAction({
      ...drainInputs(server.origin, "get-drain"),
      "request-timeout-seconds": "300",
      "session-drain-id": "drain-1",
    });

    expect(result.code).toBe(0);
    expect(server.requests).toHaveLength(1);
  });

  it.each(["0", "-1", "NaN", "Infinity", "300.001"])(
    "rejects an invalid request timeout %s before making a request",
    async (requestTimeout) => {
      const server = await serve(() => ({ body: drain("succeeded") }));

      const result = await runAction({
        ...drainInputs(server.origin, "get-drain"),
        "request-timeout-seconds": requestTimeout,
        "session-drain-id": "drain-1",
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(
        /request-timeout-seconds must be a finite positive number no greater than 300/,
      );
      expect(server.requests).toHaveLength(0);
    },
  );

  it.each([
    ["header", { delayMs: 300 }],
    ["body", { bodyDelayMs: 300 }],
  ])("times out a stalled dispatch response %s", async (_name, response) => {
    const server = await serve(() => ({
      body: { created: true, id: "session-1", url: "https://example.test/sessions/session-1" },
      ...response,
    }));

    const result = await runAction({
      ...drainInputs(server.origin, "dispatch"),
      "request-timeout-seconds": "0.1",
      prompt: "review",
      target: '{"providerId":"codex"}',
      timeout: "300",
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/Timed out waiting for Auto Harness request/);
    expect(server.requests).toHaveLength(1);
  });

  it.each([
    ["header", { delayMs: 300 }],
    ["body", { bodyDelayMs: 300 }],
  ])("times out a stalled resume response %s", async (_name, response) => {
    const server = await serve(() => ({
      body: { created: false, id: "session-1", url: "https://example.test/sessions/session-1" },
      ...response,
    }));

    const result = await runAction({
      "api-key": "test-key",
      operation: "resume",
      "request-timeout-seconds": "0.1",
      "server-url": server.origin,
      "session-id": "session-1",
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/Timed out waiting for Auto Harness request/);
    expect(server.requests).toHaveLength(1);
  });

  it.each([
    ["header", { delayMs: 300 }],
    ["body", { bodyDelayMs: 300 }],
  ])("times out a stalled drain response %s", async (_name, response) => {
    const server = await serve(() => ({ body: drain("succeeded"), ...response }));

    const result = await runAction({
      ...drainInputs(server.origin, "get-drain"),
      "request-timeout-seconds": "0.1",
      "session-drain-id": "drain-1",
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/Timed out waiting for principal session drain/);
    expect(server.requests).toHaveLength(1);
  });

  it("caps a wait request at the shorter request timeout without retrying it", async () => {
    const server = await serve(() => ({ body: drain("draining"), bodyDelayMs: 300 }));

    const result = await runAction({
      ...drainInputs(server.origin, "wait-for-drain"),
      "poll-interval-seconds": "0.001",
      "poll-timeout-seconds": "1",
      "request-timeout-seconds": "0.1",
      "session-drain-id": "drain-1",
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/Timed out waiting for principal session drain/);
    expect(server.requests).toHaveLength(1);
  });
});
