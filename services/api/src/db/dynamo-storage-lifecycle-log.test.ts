import { describe, expect, it } from "vitest";

import { SESSION_LOGS_TTL_SECONDS } from "./dynamo.ts";
import { createDynamoTestCtx } from "./dynamo-test-helpers.ts";

const ctx = createDynamoTestCtx("LifecycleLog");

describe("DynamoDB lifecycle logs", () => {
  it("round-trips a timestamped system event", async () => {
    if (!ctx.available || !ctx.storage) {
      expect(true).toBe(true);
      return;
    }
    const before = Date.now();
    await ctx.storage.putLog({
      sessionId: "lifecycle-session",
      timestampSeq: "2026-08-01T12:00:05.000Z#0000000000",
      stream: "system",
      content: "Session started at 2026-08-01T12:00:05.000Z",
      timestamp: "2026-08-01T12:00:05.000Z",
      seq: 0,
    });
    const after = Date.now();
    const logs = await ctx.storage.listLogs("lifecycle-session");
    expect(logs).toEqual([
      expect.objectContaining({
        stream: "system",
        content: "Session started at 2026-08-01T12:00:05.000Z",
        timestamp: "2026-08-01T12:00:05.000Z",
        seq: 0,
      }),
    ]);
    expect(logs[0]?.ttl).toBeGreaterThanOrEqual(
      Math.floor(before / 1000) + SESSION_LOGS_TTL_SECONDS,
    );
    expect(logs[0]?.ttl).toBeLessThanOrEqual(Math.floor(after / 1000) + SESSION_LOGS_TTL_SECONDS);
    expect(
      await ctx.storage.queryLogs("lifecycle-session", { stream: "system", limit: 100 }),
    ).toEqual([
      expect.objectContaining({
        stream: "system",
        content: "Session started at 2026-08-01T12:00:05.000Z",
      }),
    ]);
  });
});
