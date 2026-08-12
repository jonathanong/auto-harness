import { describe, expect, it } from "vitest";

import { archiveSessionLogs } from "./control-plane-lifecycle.ts";
import { createControlPlaneState } from "./control-plane-state.ts";
import { createDynamoTestCtx } from "./db/dynamo-test-helpers.ts";

const ctx = createDynamoTestCtx("ArcWr");

describe("archive writer with real DynamoDB Local", () => {
  it("reads authoritative durable logs and stores metadata after the object", async () => {
    if (!ctx.available || !ctx.storage) return expect(true).toBe(true);
    const order: string[] = [];
    await ctx.storage.putLog({
      sessionId: "session-success",
      timestampSeq: "2026-01-01T00:00:00.000Z#000000000001",
      timestamp: "2026-01-01T00:00:00.000Z",
      stream: "stdout",
      content: "durable-only",
      seq: 1,
    });
    const state = createControlPlaneState({
      storage: ctx.storage,
      archiveWriter: { putArchive: async () => void order.push("object") },
    });
    state.logs.set("session-success", []);
    const archived = await archiveSessionLogs(state, "session-success");
    order.push((await ctx.storage.getArchive(archived.key)) ? "metadata" : "missing");
    expect(archived.body).toContain("durable-only");
    expect(order).toEqual(["object", "metadata"]);
    expect(state.archives.get(archived.key)).toEqual(archived);
  });

  it("does not publish durable metadata when object storage rejects", async () => {
    if (!ctx.available || !ctx.storage) return expect(true).toBe(true);
    const state = createControlPlaneState({
      storage: ctx.storage,
      archiveWriter: {
        putArchive: async () => {
          throw new Error("object store unavailable");
        },
      },
    });
    await expect(archiveSessionLogs(state, "session-failure")).rejects.toThrow(
      "object store unavailable",
    );
    expect(await ctx.storage.getArchive("sessions/session-failure/logs.jsonl")).toBeNull();
    expect(state.archives.size).toBe(0);
  });
});
