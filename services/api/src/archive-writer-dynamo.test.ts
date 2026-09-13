import { describe, expect, it } from "vitest";

import { archiveSessionLogs, retrySessionArchiveIfNeeded } from "./control-plane-lifecycle.ts";
import { createControlPlaneState } from "./control-plane-state.ts";
import { createDynamoTestCtx } from "../test-helpers/dynamo-test-helpers.ts";

const ctx = createDynamoTestCtx("ArcWr");

describe("archive writer with real DynamoDB Local", () => {
  it("reads authoritative durable logs and stores only bounded metadata", async () => {
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
    const metadata = await ctx.storage.getArchive(archived.key);
    order.push(metadata ? "metadata" : "missing");
    expect(archived.body).toContain("durable-only");
    expect(order).toEqual(["object", "metadata"]);
    expect(metadata).toEqual({
      key: archived.key,
      contentType: archived.contentType,
      bodyBytes: Buffer.byteLength(archived.body),
      status: "complete",
      objectStored: true,
      updatedAt: expect.any(String),
    });
    expect(metadata).not.toHaveProperty("body");
    expect(state.archives.get(archived.key)).toEqual(metadata);
  });

  it("leaves a bounded pending row and retries an interrupted upload", async () => {
    if (!ctx.available || !ctx.storage) return expect(true).toBe(true);
    let unavailable = true;
    const state = createControlPlaneState({
      storage: ctx.storage,
      archiveWriter: {
        putArchive: async () => {
          if (unavailable) throw new Error("object store unavailable");
        },
      },
    });
    await expect(archiveSessionLogs(state, "session-failure")).rejects.toThrow(
      "object store unavailable",
    );
    expect(await ctx.storage.getArchive("sessions/session-failure/logs.jsonl")).toMatchObject({
      status: "pending",
      objectStored: false,
    });
    unavailable = false;
    await retrySessionArchiveIfNeeded(state, "session-failure");
    expect(await ctx.storage.getArchive("sessions/session-failure/logs.jsonl")).toMatchObject({
      status: "complete",
      objectStored: true,
    });
  });

  it("keeps metadata bounded for archives above the DynamoDB item limit", async () => {
    if (!ctx.available || !ctx.storage) return expect(true).toBe(true);
    for (let seq = 1; seq <= 5; seq += 1) {
      await ctx.storage.putLog({
        sessionId: "session-large",
        timestampSeq: `2026-01-01T00:00:00.000Z#${String(seq).padStart(12, "0")}`,
        timestamp: "2026-01-01T00:00:00.000Z",
        stream: "stdout",
        content: "x".repeat(90_000),
        seq,
      });
    }
    const state = createControlPlaneState({
      storage: ctx.storage,
      archiveWriter: { putArchive: async () => undefined },
    });
    const archived = await archiveSessionLogs(state, "session-large");
    expect(Buffer.byteLength(archived.body)).toBeGreaterThan(400_000);
    const metadata = await ctx.storage.getArchive(archived.key);
    expect(metadata?.bodyBytes).toBe(Buffer.byteLength(archived.body));
    expect(JSON.stringify(metadata).length).toBeLessThan(1_000);
    expect(metadata).not.toHaveProperty("body");
  });

  it("expires a pending archive so a late retry cannot mark it complete", async () => {
    if (!ctx.available || !ctx.storage) return expect(true).toBe(true);
    const key = "sessions/session-expired/logs.jsonl";
    await ctx.storage.putArchive({
      key,
      contentType: "application/x-ndjson",
      bodyBytes: 0,
      status: "pending",
      objectStored: false,
      retryState: "processing",
      retryOrder: "claimed-order",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await ctx.storage.putArchive({
      key: "sessions/session-complete/logs.jsonl",
      contentType: "application/x-ndjson",
      bodyBytes: 1,
      status: "complete",
      objectStored: true,
      versionId: "archive-v1",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    await expect(ctx.storage.expireArchive(key, "2026-01-08T00:00:00.000Z")).resolves.toBe(true);
    expect(await ctx.storage.getArchive(key)).toEqual({
      key,
      contentType: "application/x-ndjson",
      bodyBytes: 0,
      status: "expired",
      objectStored: false,
      updatedAt: "2026-01-08T00:00:00.000Z",
    });
    await expect(ctx.storage.listPendingArchives(25)).resolves.not.toContainEqual(
      expect.objectContaining({ key }),
    );
    await expect(
      ctx.storage.claimArchiveRetry(key, "processing", "claimed-order", "next-claim"),
    ).resolves.toBe(false);
    await expect(
      ctx.storage.completeArchiveRetry(
        {
          key,
          contentType: "application/x-ndjson",
          bodyBytes: 0,
          status: "complete",
          objectStored: true,
          updatedAt: "2026-01-08T00:00:00.000Z",
        },
        "claimed-order",
      ),
    ).resolves.toBe(false);
    expect(await ctx.storage.getArchive(key)).toMatchObject({
      status: "expired",
      objectStored: false,
    });
    await expect(
      ctx.storage.expireArchive("sessions/session-complete/logs.jsonl", "2026-01-08T00:00:00.000Z"),
    ).resolves.toBe(false);
    expect(await ctx.storage.getArchive("sessions/session-complete/logs.jsonl")).toMatchObject({
      status: "complete",
      objectStored: true,
      versionId: "archive-v1",
    });
  });
});
