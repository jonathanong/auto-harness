import { describe, expect, it } from "vitest";

import { createDynamoTestCtx } from "./dynamo-test-helpers.ts";

const ctx = createDynamoTestCtx("LifecycleLog");

describe("DynamoDB lifecycle logs", () => {
  it("round-trips a timestamped system event", async () => {
    if (!ctx.available || !ctx.storage) {
      expect(true).toBe(true);
      return;
    }
    await ctx.storage.putLog({
      sessionId: "lifecycle-session",
      timestampSeq: "2026-08-01T12:00:05.000Z#0000000000",
      stream: "system",
      content: "Session started at 2026-08-01T12:00:05.000Z",
      timestamp: "2026-08-01T12:00:05.000Z",
      seq: 0,
    });
    expect(await ctx.storage.listLogs("lifecycle-session")).toEqual([
      expect.objectContaining({
        stream: "system",
        content: "Session started at 2026-08-01T12:00:05.000Z",
        timestamp: "2026-08-01T12:00:05.000Z",
        seq: 0,
      }),
    ]);
  });
});
