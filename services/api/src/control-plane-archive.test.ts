/* eslint-disable max-lines -- archive retry regressions cover durable and in-memory fences. */
import { describe, expect, it, vi } from "vitest";

import {
  archiveSessionLogs,
  queueSessionArchive,
  retryPendingArchives,
  retrySessionArchiveIfNeeded,
} from "./control-plane-archive.ts";
import { createControlPlaneState, settleStorage, trackLogPersist } from "./control-plane-state.ts";

describe("archive retry state", () => {
  it("stays disabled without a writer and skips a completed cached object", async () => {
    const disabled = createControlPlaneState();
    await expect(retrySessionArchiveIfNeeded(disabled, "disabled")).resolves.toBeUndefined();

    let uploads = 0;
    const complete = createControlPlaneState({
      archiveWriter: { putArchive: async () => void (uploads += 1) },
    });
    complete.archives.set("sessions/complete/logs.jsonl", {
      key: "sessions/complete/logs.jsonl",
      contentType: "application/x-ndjson",
      bodyBytes: 0,
      status: "complete",
      objectStored: true,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await retrySessionArchiveIfNeeded(complete, "complete");
    expect(uploads).toBe(0);
  });

  it("does not retry a durably expired archive", async () => {
    let uploads = 0;
    const state = createControlPlaneState({
      archiveWriter: { putArchive: async () => void (uploads += 1) },
    });
    const key = "sessions/expired/logs.jsonl";
    state.archives.set(key, {
      key,
      contentType: "application/x-ndjson",
      bodyBytes: 0,
      status: "expired",
      objectStored: false,
      updatedAt: "2026-01-08T00:00:00.000Z",
    });
    await retrySessionArchiveIfNeeded(state, "expired");
    expect(uploads).toBe(0);
    expect(state.archives.get(key)?.status).toBe("expired");
  });

  it("does not select an expired in-memory row even if retry attributes remain", async () => {
    const uploaded: string[] = [];
    const state = createControlPlaneState({
      archiveWriter: { putArchive: async ({ key }) => void uploaded.push(key) },
    });
    state.archives.set("sessions/expired/logs.jsonl", {
      key: "sessions/expired/logs.jsonl",
      contentType: "application/x-ndjson",
      bodyBytes: 0,
      status: "expired",
      objectStored: false,
      retryState: "pending",
      retryOrder: "2026-01-01T00:00:00.000Z#sessions/expired/logs.jsonl",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await expect(retryPendingArchives(state, 25)).resolves.toBe(0);
    expect(uploaded).toEqual([]);
    expect(state.archives.get("sessions/expired/logs.jsonl")?.status).toBe("expired");
  });

  it("retries pending cached metadata without durable storage", async () => {
    const uploaded: string[] = [];
    const state = createControlPlaneState({
      archiveWriter: { putArchive: async ({ key }) => void uploaded.push(key) },
    });
    state.archives.set("sessions/pending/logs.jsonl", {
      key: "sessions/pending/logs.jsonl",
      contentType: "application/x-ndjson",
      bodyBytes: 0,
      status: "pending",
      objectStored: false,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await retrySessionArchiveIfNeeded(state, "pending");
    expect(uploaded).toEqual(["sessions/pending/logs.jsonl"]);
    expect(state.archives.get("sessions/pending/logs.jsonl")?.status).toBe("complete");
  });

  it("waits for log writes without inheriting an unrelated failed archive", async () => {
    let releaseLog: (() => void) | undefined;
    const logWrite = new Promise<void>((resolve) => {
      releaseLog = resolve;
    });
    const failedArchive = Promise.reject(new Error("earlier archive failed"));
    void failedArchive.catch(() => undefined);
    const uploaded: string[] = [];
    const state = createControlPlaneState({
      archiveWriter: { putArchive: async ({ key }) => void uploaded.push(key) },
    });
    state.pendingPersists.push(failedArchive);
    trackLogPersist(state, "later-session", logWrite);

    const archive = archiveSessionLogs(state, "later-session");
    await Promise.resolve();
    expect(uploaded).toEqual([]);
    releaseLog?.();
    await expect(archive).resolves.toMatchObject({ key: "sessions/later-session/logs.jsonl" });
    expect(uploaded).toEqual(["sessions/later-session/logs.jsonl"]);
  });

  it("observes queued archive rejection until storage settlement propagates it", async () => {
    const state = createControlPlaneState({
      archiveWriter: {
        putArchive: async () => {
          throw new Error("temporary archive outage");
        },
      },
    });

    queueSessionArchive(state, "failed");
    await expect(settleStorage(state)).rejects.toThrow("temporary archive outage");
  });

  it("sweeps a bounded page and isolates one failed upload from later archives", async () => {
    const uploaded: string[] = [];
    const state = createControlPlaneState({
      archiveWriter: {
        putArchive: async ({ key }) => {
          if (key.includes("failed")) throw new Error("S3 unavailable");
          uploaded.push(key);
        },
      },
      now: () => "2026-01-01T00:00:00.000Z",
    });
    for (const sessionId of ["failed", "later"]) {
      state.archives.set(`sessions/${sessionId}/logs.jsonl`, {
        key: `sessions/${sessionId}/logs.jsonl`,
        contentType: "application/x-ndjson",
        bodyBytes: 0,
        status: "complete",
        objectStored: false,
        retryState: "pending",
        retryOrder: `2026-01-01T00:00:00.000Z#sessions/${sessionId}/logs.jsonl`,
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
    }
    state.archives.set("other-prefix/ignored", {
      key: "other-prefix/ignored",
      contentType: "application/x-ndjson",
      bodyBytes: 0,
      status: "complete",
      objectStored: false,
      retryState: "pending",
      retryOrder: "2026-01-01T00:00:00.000Z#other-prefix/ignored",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    await expect(retryPendingArchives(state, 25)).resolves.toBe(1);
    expect(uploaded).toHaveLength(1);
    expect(uploaded[0]).toBe("sessions/later/logs.jsonl");
    expect(state.archives.get("sessions/failed/logs.jsonl")?.objectStored).toBe(false);
    expect(state.archives.get("sessions/later/logs.jsonl")?.objectStored).toBe(true);
  });

  it("does not let an older retry claim complete over a newer claim", async () => {
    let releaseUpload!: () => void;
    const uploadStarted = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    const state = createControlPlaneState({
      archiveWriter: { putArchive: async () => uploadStarted },
      now: () => "2026-01-01T00:00:00.000Z",
    });
    const key = "sessions/fenced/logs.jsonl";
    state.archives.set(key, {
      key,
      contentType: "application/x-ndjson",
      bodyBytes: 0,
      status: "complete",
      objectStored: false,
      retryState: "processing",
      retryOrder: "old-claim",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const retry = retrySessionArchiveIfNeeded(state, "fenced", {
      retryState: "processing",
      retryOrder: "old-claim",
    });
    await Promise.resolve();
    state.archives.set(key, {
      key,
      contentType: "application/x-ndjson",
      bodyBytes: 0,
      status: "complete",
      objectStored: false,
      retryState: "pending",
      retryOrder: "new-claim",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    releaseUpload();
    await retry;

    expect(state.archives.get(key)).toMatchObject({
      objectStored: false,
      retryState: "pending",
      retryOrder: "new-claim",
    });
  });

  it("does not let a late retry complete over an expired archive", async () => {
    let releaseUpload!: () => void;
    const uploadStarted = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    const state = createControlPlaneState({
      archiveWriter: { putArchive: async () => uploadStarted },
      now: () => "2026-01-08T00:00:00.000Z",
    });
    const key = "sessions/expired-race/logs.jsonl";
    state.archives.set(key, {
      key,
      contentType: "application/x-ndjson",
      bodyBytes: 0,
      status: "pending",
      objectStored: false,
      retryState: "processing",
      retryOrder: "old-claim",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const retry = retrySessionArchiveIfNeeded(state, "expired-race", {
      retryState: "processing",
      retryOrder: "old-claim",
    });
    await Promise.resolve();
    state.archives.set(key, {
      key,
      contentType: "application/x-ndjson",
      bodyBytes: 0,
      status: "expired",
      objectStored: false,
      updatedAt: "2026-01-08T00:00:00.000Z",
    });
    releaseUpload();
    await retry;

    expect(state.archives.get(key)).toMatchObject({
      status: "expired",
      objectStored: false,
    });
    expect(state.archives.get(key)).not.toHaveProperty("retryState");
  });

  it("does not restore a stale same-key upload over a newer durable retry generation", async () => {
    const uploaded: string[] = [];
    const key = "sessions/durable-fenced/logs.jsonl";
    const newer: import("./control-plane-types.ts").ArchiveMetadata = {
      key,
      contentType: "application/x-ndjson",
      bodyBytes: 0,
      status: "pending",
      objectStored: false,
      retryState: "processing",
      retryOrder: "new-claim",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const state = createControlPlaneState({
      archiveWriter: { putArchive: async ({ body }) => void uploaded.push(body) },
      storage: {
        getArchive: async () => newer,
        listLogs: async () => [{ timestamp: "1", stream: "stdout", content: "old" }],
        completeArchiveRetry: async () => false,
      } as never,
    });
    await retrySessionArchiveIfNeeded(state, "durable-fenced", {
      retryState: "processing",
      retryOrder: "old-claim",
    });
    expect(uploaded).toEqual(['{"timestamp":"1","stream":"stdout","content":"old"}\n']);
  });

  it("persists a retry marker without reading logs when the writer is absent", async () => {
    const putArchive = vi.fn(async () => undefined);
    const listLogs = vi.fn(async () => {
      throw new Error("WS invocation must not materialize logs");
    });
    const state = createControlPlaneState({
      storage: { putArchive, listLogs } as never,
    });
    const object = await archiveSessionLogs(state, "ws-only", undefined, true);
    expect(object).toMatchObject({ key: "sessions/ws-only/logs.jsonl", body: "" });
    expect(listLogs).not.toHaveBeenCalled();
    expect(putArchive).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "sessions/ws-only/logs.jsonl",
        status: "pending",
        objectStored: false,
        retryState: "pending",
      }),
    );
  });

  it("preserves an existing retry claim when deferring without a writer", async () => {
    const state = createControlPlaneState();
    const object = await archiveSessionLogs(
      state,
      "claimed",
      { retryState: "processing", retryOrder: "claim-order" },
      true,
    );
    expect(object.body).toBe("");
    expect(state.archives.get("sessions/claimed/logs.jsonl")).toBeUndefined();
  });

  it("commits a durable retry generation and updates the in-memory mirror", async () => {
    const completeArchiveRetry = vi.fn(async () => true);
    const state = createControlPlaneState({
      archiveWriter: { putArchive: async () => undefined },
      storage: {
        getArchive: async () => ({
          key: "sessions/durable-commit/logs.jsonl",
          contentType: "application/x-ndjson",
          bodyBytes: 0,
          status: "pending",
          objectStored: false,
          retryState: "processing",
          retryOrder: "claim-order",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
        listLogs: async () => [],
        completeArchiveRetry,
      } as never,
    });
    await retrySessionArchiveIfNeeded(state, "durable-commit", {
      retryState: "processing",
      retryOrder: "claim-order",
    });
    expect(completeArchiveRetry).toHaveBeenCalledOnce();
    expect(state.archives.get("sessions/durable-commit/logs.jsonl")).toMatchObject({
      status: "complete",
      objectStored: true,
    });
  });

  it("records captured retry bytes before the object PUT", async () => {
    const order: string[] = [];
    const recordArchiveRetryCapture = vi.fn(async () => true);
    const state = createControlPlaneState({
      archiveWriter: {
        putArchive: async () => {
          order.push("object");
        },
      },
      storage: {
        getArchive: async () => undefined,
        listLogs: async () => [{ timestamp: "1", stream: "stdout", content: "captured" }],
        recordArchiveRetryCapture: async (...args: unknown[]) => {
          order.push("capture");
          return recordArchiveRetryCapture(...args);
        },
        completeArchiveRetry: async () => true,
      } as never,
    });
    const key = "sessions/capture/logs.jsonl";
    state.archives.set(key, {
      key,
      contentType: "application/x-ndjson",
      bodyBytes: 0,
      status: "pending",
      objectStored: false,
      retryState: "processing",
      retryOrder: "claim-order",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await retrySessionArchiveIfNeeded(state, "capture", {
      retryState: "processing",
      retryOrder: "claim-order",
    });
    expect(order).toEqual(["capture", "object"]);
    expect(recordArchiveRetryCapture).toHaveBeenCalledWith(
      key,
      "claim-order",
      expect.any(Number),
      expect.any(String),
    );
  });

  it("does not upload when a processing claim loses the capture fence", async () => {
    let uploaded = 0;
    const state = createControlPlaneState({
      archiveWriter: { putArchive: async () => void (uploaded += 1) },
      storage: {
        getArchive: async () => undefined,
        listLogs: async () => [{ timestamp: "1", stream: "stdout", content: "captured" }],
        recordArchiveRetryCapture: async () => false,
        completeArchiveRetry: async () => true,
      } as never,
    });
    await retrySessionArchiveIfNeeded(state, "lost-capture", {
      retryState: "processing",
      retryOrder: "claim-order",
    });
    expect(uploaded).toBe(0);
  });

  it("writes a durable pending marker when an in-memory claim has storage but no retry fence", async () => {
    const putArchive = vi.fn(async () => undefined);
    const key = "sessions/storage-claim/logs.jsonl";
    const state = createControlPlaneState({
      archiveWriter: { putArchive: async () => undefined },
      storage: {
        getArchive: async () => ({
          key,
          contentType: "application/x-ndjson",
          bodyBytes: 0,
          status: "pending",
          objectStored: false,
          retryState: "processing",
          retryOrder: "claim-order",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
        listLogs: async () => [],
        putArchive,
      } as never,
    });
    state.archives.set(key, {
      key,
      contentType: "application/x-ndjson",
      bodyBytes: 0,
      status: "pending",
      objectStored: false,
      retryState: "processing",
      retryOrder: "claim-order",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await retrySessionArchiveIfNeeded(state, "storage-claim", {
      retryState: "processing",
      retryOrder: "claim-order",
    });
    expect(putArchive).toHaveBeenCalledWith(expect.objectContaining({ key }));
  });

  it("sweeps durable candidates and releases a failed claim", async () => {
    const releaseArchiveRetry = vi.fn(async () => undefined);
    const state = createControlPlaneState({
      archiveWriter: {
        putArchive: async () => {
          throw new Error("upload failed");
        },
      },
      storage: {
        listPendingArchives: async () => [
          { key: "sessions/durable-failed/logs.jsonl", objectStored: false, retryOrder: "one" },
        ],
        claimArchiveRetry: async () => true,
        releaseArchiveRetry,
        getArchive: async () => null,
        listLogs: async () => [],
      } as never,
    });
    await expect(retryPendingArchives(state)).resolves.toBe(0);
    expect(releaseArchiveRetry).toHaveBeenCalledOnce();
  });

  it("returns zero when the durable retry index is unavailable", async () => {
    const state = createControlPlaneState({
      archiveWriter: { putArchive: async () => undefined },
      storage: {
        listPendingArchives: async () => {
          throw new Error("index unavailable");
        },
      } as never,
    });
    await expect(retryPendingArchives(state)).resolves.toBe(0);
  });

  it("does not release a claim when the release operation itself fails", async () => {
    const state = createControlPlaneState({
      archiveWriter: {
        putArchive: async () => {
          throw new Error("upload failed");
        },
      },
      storage: {
        listPendingArchives: async () => [
          { key: "sessions/release-failed/logs.jsonl", objectStored: false, retryOrder: "one" },
        ],
        claimArchiveRetry: async () => true,
        releaseArchiveRetry: async () => {
          throw new Error("release failed");
        },
        getArchive: async () => null,
        listLogs: async () => [],
      } as never,
    });
    await expect(retryPendingArchives(state)).resolves.toBe(0);
  });

  it("preserves a newer local claim when a stale upload fails", async () => {
    const key = "sessions/local-fenced/logs.jsonl";
    const state = createControlPlaneState({
      now: () => "2026-01-01T00:00:00.000Z",
      archiveWriter: {
        putArchive: async () => {
          state.archives.set(key, {
            key,
            contentType: "application/x-ndjson",
            bodyBytes: 0,
            status: "pending",
            objectStored: false,
            retryState: "pending",
            retryOrder: "new-claim",
            updatedAt: "2026-01-01T00:00:00.000Z",
          });
          throw new Error("stale upload failed");
        },
      },
    });
    state.archives.set(key, {
      key,
      contentType: "application/x-ndjson",
      bodyBytes: 0,
      status: "pending",
      objectStored: false,
      retryState: "pending",
      retryOrder: "old-claim",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    await expect(retryPendingArchives(state)).resolves.toBe(0);
    expect(state.archives.get(key)).toMatchObject({
      retryState: "pending",
      retryOrder: "new-claim",
    });
  });

  it("does not rewrite a newer pending generation when a stale upload loses its fence", async () => {
    let releaseUpload!: () => void;
    const uploaded: string[] = [];
    const uploadStarted = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    const state = createControlPlaneState({
      archiveWriter: {
        putArchive: async ({ body }) => {
          uploaded.push(body);
          if (uploaded.length === 1) await uploadStarted;
        },
      },
    });
    const key = "sessions/fenced-current/logs.jsonl";
    state.logs.set("fenced-current", [
      { timestamp: "1", stream: "stdout", content: "old" } as never,
    ]);
    state.archives.set(key, {
      key,
      contentType: "application/x-ndjson",
      bodyBytes: 0,
      status: "complete",
      objectStored: false,
      retryState: "processing",
      retryOrder: "old-claim",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const retry = retrySessionArchiveIfNeeded(state, "fenced-current", {
      retryState: "processing",
      retryOrder: "old-claim",
    });
    await Promise.resolve();
    state.logs.set("fenced-current", [
      { timestamp: "1", stream: "stdout", content: "new" } as never,
    ]);
    state.archives.set(key, {
      key,
      contentType: "application/x-ndjson",
      bodyBytes: 0,
      status: "complete",
      objectStored: false,
      retryState: "pending",
      retryOrder: "new-claim",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    releaseUpload();
    await retry;

    expect(uploaded).toHaveLength(1);
    expect(uploaded[0]).toBe('{"timestamp":"1","stream":"stdout","content":"old"}\n');
  });

  it("republishes the newer winner after a stale canonical upload loses its fence", async () => {
    let releaseUpload!: () => void;
    const uploadStarted = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    const uploaded: string[] = [];
    const key = "sessions/fenced-winner/logs.jsonl";
    const state = createControlPlaneState({
      archiveWriter: {
        putArchive: async ({ body }) => {
          uploaded.push(body);
          if (uploaded.length === 1) await uploadStarted;
        },
      },
      now: () => "2026-01-01T00:00:00.000Z",
    });
    state.logs.set("fenced-winner", [
      { timestamp: "1", stream: "stdout", content: "old" } as never,
    ]);
    state.archives.set(key, {
      key,
      contentType: "application/x-ndjson",
      bodyBytes: 0,
      status: "complete",
      objectStored: false,
      retryState: "processing",
      retryOrder: "old-claim",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const retry = retrySessionArchiveIfNeeded(state, "fenced-winner", {
      retryState: "processing",
      retryOrder: "old-claim",
    });
    await Promise.resolve();
    state.logs.set("fenced-winner", [
      { timestamp: "1", stream: "stdout", content: "new" } as never,
    ]);
    state.archives.set(key, {
      key,
      contentType: "application/x-ndjson",
      bodyBytes: 0,
      status: "complete",
      objectStored: true,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    releaseUpload();
    await retry;

    expect(uploaded).toEqual([
      '{"timestamp":"1","stream":"stdout","content":"old"}\n',
      '{"timestamp":"1","stream":"stdout","content":"new"}\n',
    ]);
  });

  it.each(["missing-result", "missing-version"])(
    "does not publish a repaired legacy winner when the writer has a %s",
    async (resultKind) => {
      const key = `sessions/legacy-${resultKind}/logs.jsonl`;
      const pending = {
        key,
        contentType: "application/x-ndjson",
        bodyBytes: 0,
        status: "pending" as const,
        objectStored: false,
        retryState: "processing" as const,
        retryOrder: "claim-order",
        updatedAt: "2026-01-01T00:00:00.000Z",
      };
      const complete = { ...pending, status: "complete" as const, objectStored: true };
      let reads = 0;
      const state = createControlPlaneState({
        archiveWriter: {
          putArchive: async () => (resultKind === "missing-version" ? ({} as never) : undefined),
        },
        storage: {
          getArchive: async () => (reads++ === 0 ? pending : complete),
          listLogs: async () => [{ timestamp: "1", stream: "stdout", content: "legacy" }],
          completeArchiveRetry: async () => false,
        } as never,
      });
      await retrySessionArchiveIfNeeded(state, `legacy-${resultKind}`, {
        retryState: "processing",
        retryOrder: "claim-order",
      });
      expect(reads).toBe(2);
      expect(state.archives.get(key)?.versionId).toBeUndefined();
    },
  );

  it("persists a repaired legacy winner identity to durable metadata", async () => {
    const key = "sessions/legacy-durable/logs.jsonl";
    const pending = {
      key,
      contentType: "application/x-ndjson",
      bodyBytes: 0,
      status: "pending" as const,
      objectStored: false,
      retryState: "processing" as const,
      retryOrder: "claim-order",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const complete = { ...pending, status: "complete" as const, objectStored: true };
    let reads = 0;
    const putArchive = vi.fn(async () => undefined);
    const state = createControlPlaneState({
      archiveWriter: { putArchive: async () => ({ versionId: "repaired-v1" }) },
      storage: {
        getArchive: async () => (reads++ === 0 ? pending : complete),
        listLogs: async () => [{ timestamp: "1", stream: "stdout", content: "legacy" }],
        completeArchiveRetry: async () => false,
        putArchive,
      } as never,
    });
    await retrySessionArchiveIfNeeded(state, "legacy-durable", {
      retryState: "processing",
      retryOrder: "claim-order",
    });
    expect(putArchive).toHaveBeenCalledWith(expect.objectContaining({ versionId: "repaired-v1" }));
    expect(state.archives.get(key)).toMatchObject({
      versionId: "repaired-v1",
      bodyBytes: expect.any(Number),
    });
  });

  it("repairs a legacy winner in the in-memory retry fence", async () => {
    const key = "sessions/legacy-memory/logs.jsonl";
    let releaseUpload!: () => void;
    const uploadStarted = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    const state = createControlPlaneState({
      archiveWriter: {
        putArchive: async () => {
          await uploadStarted;
          return { versionId: "memory-repaired-v1" };
        },
      },
    });
    state.logs.set("legacy-memory", [
      { timestamp: "1", stream: "stdout", content: "legacy" } as never,
    ]);
    state.archives.set(key, {
      key,
      contentType: "application/x-ndjson",
      bodyBytes: 0,
      status: "pending",
      objectStored: false,
      retryState: "processing",
      retryOrder: "claim-order",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const retry = retrySessionArchiveIfNeeded(state, "legacy-memory", {
      retryState: "processing",
      retryOrder: "claim-order",
    });
    await Promise.resolve();
    state.archives.set(key, {
      key,
      contentType: "application/x-ndjson",
      bodyBytes: 0,
      status: "complete",
      objectStored: true,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    releaseUpload();
    await retry;
    expect(state.archives.get(key)).toMatchObject({ versionId: "memory-repaired-v1" });
  });

  it("releases a matching local retry claim after an upload failure", async () => {
    const key = "sessions/local-release/logs.jsonl";
    const state = createControlPlaneState({
      archiveWriter: {
        putArchive: async () => {
          throw new Error("upload failed");
        },
      },
    });
    state.archives.set(key, {
      key,
      contentType: "application/x-ndjson",
      bodyBytes: 0,
      status: "pending",
      objectStored: false,
      retryState: "pending",
      retryOrder: "old-order",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await expect(retryPendingArchives(state)).resolves.toBe(0);
    expect(state.archives.get(key)).toMatchObject({ retryState: "pending" });
  });

  it("does not reset a replaced local claim after an upload failure", async () => {
    const key = "sessions/replaced-after-failure/logs.jsonl";
    let state: ReturnType<typeof createControlPlaneState>;
    state = createControlPlaneState({
      archiveWriter: {
        putArchive: async () => {
          state.archives.set(key, {
            key,
            contentType: "application/x-ndjson",
            bodyBytes: 0,
            status: "pending",
            objectStored: false,
            retryState: "pending",
            retryOrder: "new-order",
            updatedAt: "2026-01-01T00:00:00.000Z",
          });
          throw new Error("upload failed");
        },
      },
    });
    state.archives.set(key, {
      key,
      contentType: "application/x-ndjson",
      bodyBytes: 0,
      status: "pending",
      objectStored: false,
      retryState: "pending",
      retryOrder: "old-order",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await expect(retryPendingArchives(state)).resolves.toBe(0);
    expect(state.archives.get(key)?.retryOrder).toBe("new-order");
  });

  it("keeps a retry pointer if the archive writer disappears after uploading", async () => {
    const putArchive = vi.fn(async () => undefined);
    const writer = { putArchive };
    const state = createControlPlaneState({
      archiveWriter: writer,
      now: () => "2026-01-01T00:00:00.000Z",
    });
    let writerReads = 0;
    Object.defineProperty(state, "archiveWriter", {
      configurable: true,
      get() {
        writerReads += 1;
        return writerReads <= 3 ? writer : undefined;
      },
    });

    await archiveSessionLogs(state, "writer-gone");
    expect(putArchive).toHaveBeenCalledOnce();
    expect(state.archives.get("sessions/writer-gone/logs.jsonl")).toMatchObject({
      status: "complete",
      objectStored: false,
      retryState: "pending",
      retryOrder: "2026-01-01T00:00:00.000Z#sessions/writer-gone/logs.jsonl",
    });
  });

  it("includes processing retries and sorts missing retry orders by archive key", async () => {
    const uploaded: string[] = [];
    const state = createControlPlaneState({
      archiveWriter: { putArchive: async ({ key }) => void uploaded.push(key) },
    });
    for (const [sessionId, retryState] of [
      ["missing-order-processing", "processing"],
      ["missing-order-pending", "pending"],
    ] as const) {
      const key = `sessions/${sessionId}/logs.jsonl`;
      state.archives.set(key, {
        key,
        contentType: "application/x-ndjson",
        bodyBytes: 0,
        status: "pending",
        objectStored: false,
        retryState,
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
    }

    await expect(retryPendingArchives(state)).resolves.toBe(0);
    expect(uploaded).toEqual([]);
  });

  it("stops a sweep before the next candidate and skips a declined durable claim", async () => {
    const uploaded: string[] = [];
    const state = createControlPlaneState({
      archiveWriter: { putArchive: async ({ key }) => void uploaded.push(key) },
    });
    state.archives.set("sessions/stopped/logs.jsonl", {
      key: "sessions/stopped/logs.jsonl",
      contentType: "application/x-ndjson",
      bodyBytes: 0,
      status: "pending",
      objectStored: false,
      retryState: "pending",
      retryOrder: "one",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await expect(retryPendingArchives(state, 25, () => false)).resolves.toBe(0);

    const claimArchiveRetry = vi.fn(async () => false);
    state.storage = {
      listPendingArchives: async () => [
        {
          key: "sessions/declined/logs.jsonl",
          contentType: "application/x-ndjson",
          bodyBytes: 0,
          status: "pending",
          objectStored: false,
          retryState: "pending",
          retryOrder: "two",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      claimArchiveRetry,
    } as never;
    await expect(retryPendingArchives(state)).resolves.toBe(0);
    expect(claimArchiveRetry).toHaveBeenCalledOnce();
    expect(uploaded).toEqual([]);
  });

  it("skips a local retry whose claim was replaced after the candidate page was read", async () => {
    const uploaded: string[] = [];
    const state = createControlPlaneState({
      archiveWriter: { putArchive: async ({ key }) => void uploaded.push(key) },
    });
    const key = "sessions/replaced-local-claim/logs.jsonl";
    const original = {
      key,
      contentType: "application/x-ndjson",
      bodyBytes: 0,
      status: "pending" as const,
      objectStored: false,
      retryState: "pending" as const,
      retryOrder: "old-claim",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    state.archives.set(key, original);

    await expect(
      retryPendingArchives(state, 25, () => {
        state.archives.set(key, { ...original, retryOrder: "new-claim" });
        return true;
      }),
    ).resolves.toBe(0);
    expect(uploaded).toEqual([]);
    expect(state.archives.get(key)?.retryOrder).toBe("new-claim");
  });
});
