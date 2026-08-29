import { afterEach, describe, expect, it } from "vitest";

import {
  closeDispatchActionServers,
  drain,
  drainInputs,
  runAction,
  serve,
} from "./dispatch-action-test-helpers.ts";

afterEach(closeDispatchActionServers);

describe("dispatch action principal session drain operations", () => {
  it("starts a drain with idempotency and exposes an absolute status URL", async () => {
    const server = await serve(() => ({ body: drain("draining"), status: 202 }));

    const result = await runAction({
      ...drainInputs(server.origin, "start-drain"),
      "idempotency-key": "deployment-42",
    });

    expect(result.code).toBe(0);
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]).toMatchObject({
      method: "POST",
      url: "/api/v1/repositories/repo%2Fone/session-drains",
      headers: expect.objectContaining({ "idempotency-key": "deployment-42" }),
    });
    expect(result.output).toMatchObject({
      "operation-id": "drain-1",
      "drain-status": "draining",
      "drain-terminal": "false",
      "status-url": `${server.origin}/api/v1/repositories/repo%2Fone/session-drains/drain-1`,
    });
  });

  it("gets a bounded drain status with the default request timeout", async () => {
    const server = await serve(() => ({ body: drain("succeeded") }));

    const result = await runAction({
      ...drainInputs(server.origin, "get-drain"),
      "session-drain-id": "drain-1",
    });

    expect(result.code).toBe(0);
    expect(server.requests[0]).toMatchObject({
      method: "GET",
      url: "/api/v1/repositories/repo%2Fone/session-drains/drain-1",
    });
    expect(result.output["drain-status"]).toBe("succeeded");
  });

  it("fails closed when a start replay is already failed", async () => {
    const server = await serve(() => ({
      body: drain("failed", { failureCode: "DRAIN_DEADLINE_EXCEEDED" }),
    }));

    const result = await runAction(drainInputs(server.origin, "start-drain"));

    expect(result.code).toBe(1);
    expect(result.output).toMatchObject({
      "drain-status": "failed",
      "failure-code": "DRAIN_DEADLINE_EXCEEDED",
    });
    expect(result.stderr).toMatch(/did not start an active principal session drain: failed/);
  });

  it("waits until succeeded and never mistakes draining for terminal proof", async () => {
    let calls = 0;
    const server = await serve(() => ({ body: drain(++calls === 1 ? "draining" : "succeeded") }));

    const result = await runAction({
      ...drainInputs(server.origin, "wait-for-drain"),
      "poll-interval-seconds": "0.001",
      "poll-timeout-seconds": "1",
      "session-drain-id": "drain-1",
    });

    expect(result.code).toBe(0);
    expect(server.requests).toHaveLength(2);
    expect(result.output).toMatchObject({ "drain-status": "succeeded", "drain-terminal": "true" });
  });

  it("releases a terminal drain only when the control plane confirms release", async () => {
    const server = await serve(() => ({ body: drain("released") }));

    const result = await runAction({
      ...drainInputs(server.origin, "release-drain"),
      "session-drain-id": "drain-1",
    });

    expect(result.code).toBe(0);
    expect(server.requests[0]).toMatchObject({
      method: "POST",
      url: "/api/v1/repositories/repo%2Fone/session-drains/drain-1/release",
    });
    expect(result.output["drain-status"]).toBe("released");
  });

  it("exposes drain outputs when release does not confirm release", async () => {
    const server = await serve(() => ({
      body: drain("failed", { failureCode: "DRAIN_DEADLINE_EXCEEDED" }),
    }));

    const result = await runAction({
      ...drainInputs(server.origin, "release-drain"),
      "session-drain-id": "drain-1",
    });

    expect(result.code).toBe(1);
    expect(result.output).toMatchObject({
      "drain-status": "failed",
      "failure-code": "DRAIN_DEADLINE_EXCEEDED",
    });
    expect(result.stderr).toMatch(/did not release principal session drain: failed/);
  });

  it.each([
    [
      "failed",
      drain("failed", { failureCode: "DRAIN_DEADLINE_EXCEEDED" }),
      /did not succeed: failed/,
    ],
    ["released", drain("released"), /did not succeed: released/],
    ["unknown", drain("unexpected"), /unknown principal session drain status/],
  ])("fails closed when wait receives a %s terminal result", async (_name, body, expectedError) => {
    const server = await serve(() => ({ body }));

    const result = await runAction({
      ...drainInputs(server.origin, "wait-for-drain"),
      "poll-interval-seconds": "0.001",
      "poll-timeout-seconds": "1",
      "session-drain-id": "drain-1",
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(expectedError);
  });

  it("times out while the drain remains active", async () => {
    const server = await serve(() => ({ body: drain("draining") }));

    const result = await runAction({
      ...drainInputs(server.origin, "wait-for-drain"),
      "poll-interval-seconds": "0.001",
      "poll-timeout-seconds": "0.005",
      "session-drain-id": "drain-1",
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/Timed out waiting for principal session drain/);
    expect(server.requests.length).toBeLessThanOrEqual(1);
  });

  it("aborts a stalled status request at the polling deadline", async () => {
    const server = await serve(() => ({ body: drain("draining"), delayMs: 100 }));

    const result = await runAction({
      ...drainInputs(server.origin, "wait-for-drain"),
      "poll-interval-seconds": "0.001",
      "poll-timeout-seconds": "0.02",
      "session-drain-id": "drain-1",
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/Timed out waiting for principal session drain/);
    expect(server.requests.length).toBeLessThanOrEqual(1);
  });

  it("makes DRAINING dispatch failures directly actionable", async () => {
    const server = await serve(() => ({
      status: 409,
      body: {
        error: {
          code: "DRAINING",
          message: "principal session admission is draining",
          operationId: "drain-1",
          statusUrl: "/api/v1/repositories/repo%2Fone/session-drains/drain-1",
        },
      },
    }));

    const result = await runAction({
      ...drainInputs(server.origin, "dispatch"),
      prompt: "review",
      target: '{"providerId":"codex"}',
      timeout: "300",
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      `drain drain-1: ${server.origin}/api/v1/repositories/repo%252Fone/session-drains/drain-1`,
    );
  });

  it("rejects a malformed successful dispatch response", async () => {
    const server = await serve(() => ({ body: {} }));

    const result = await runAction({
      ...drainInputs(server.origin, "dispatch"),
      prompt: "review",
      target: '{"providerId":"codex"}',
      timeout: "300",
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/session without a valid id/);
    expect(result.output).toEqual({});
  });
});
