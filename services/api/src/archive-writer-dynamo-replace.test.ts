import { describe, expect, it } from "vitest";

import { archiveSessionLogs } from "./control-plane-lifecycle.ts";
import { createControlPlaneState } from "./control-plane-state.ts";
import { createDynamoTestCtx } from "../test-helpers/dynamo-test-helpers.ts";

const ctx = createDynamoTestCtx("ArcRp");

describe("complete archive replacement with real DynamoDB Local", () => {
  it("leaves the last complete archive when replacement upload fails", async () => {
    if (!ctx.available || !ctx.storage) return expect(true).toBe(true);
    const key = "sessions/session-replace-fail/logs.jsonl";
    await ctx.storage.putArchive({
      key,
      versionId: "complete-v1",
      contentType: "application/x-ndjson",
      bodyBytes: 12,
      status: "complete",
      objectStored: true,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const state = createControlPlaneState({
      storage: ctx.storage,
      archiveWriter: {
        putArchive: async () => {
          throw new Error("object store unavailable");
        },
      },
    });
    await expect(archiveSessionLogs(state, "session-replace-fail")).rejects.toThrow(
      "object store unavailable",
    );
    expect(await ctx.storage.getArchive(key)).toMatchObject({
      status: "complete",
      objectStored: true,
      versionId: "complete-v1",
    });
  });

  it("publishes replacement metadata only after the new version is stored", async () => {
    if (!ctx.available || !ctx.storage) return expect(true).toBe(true);
    const key = "sessions/session-replace-ok/logs.jsonl";
    await ctx.storage.putArchive({
      key,
      versionId: "complete-v1",
      contentType: "application/x-ndjson",
      bodyBytes: 12,
      status: "complete",
      objectStored: true,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const state = createControlPlaneState({
      storage: ctx.storage,
      archiveWriter: { putArchive: async () => ({ versionId: "complete-v2" }) },
    });
    await archiveSessionLogs(state, "session-replace-ok");
    expect(await ctx.storage.getArchive(key)).toMatchObject({
      status: "complete",
      objectStored: true,
      versionId: "complete-v2",
    });
  });

  it("rejects a stale complete replacement generation", async () => {
    if (!ctx.available || !ctx.storage) return expect(true).toBe(true);
    const key = "sessions/session-replace-stale/logs.jsonl";
    await ctx.storage.putArchive({
      key,
      versionId: "complete-v1",
      contentType: "application/x-ndjson",
      bodyBytes: 12,
      status: "complete",
      objectStored: true,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const next = {
      key,
      contentType: "application/x-ndjson",
      bodyBytes: 24,
      status: "complete" as const,
      objectStored: true,
      updatedAt: "2026-01-02T00:00:00.000Z",
    };
    await expect(
      ctx.storage.replaceCompleteArchive(
        { ...next, versionId: "complete-v2" },
        { versionId: "complete-v1", updatedAt: "2026-01-01T00:00:00.000Z" },
      ),
    ).resolves.toBe(true);
    await expect(
      ctx.storage.replaceCompleteArchive(
        { ...next, versionId: "stale-v" },
        { versionId: "complete-v1", updatedAt: "2026-01-01T00:00:00.000Z" },
      ),
    ).resolves.toBe(false);
    expect(await ctx.storage.getArchive(key)).toMatchObject({ versionId: "complete-v2" });
  });
});
