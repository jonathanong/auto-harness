/* eslint-disable max-lines -- archive retry regressions cover durable and in-memory fences. */
import { describe, expect, it, vi } from "vitest";

import {
  archiveSessionLogs,
  retryPendingArchives,
  retrySessionArchiveIfNeeded,
} from "./control-plane-archive.ts";
import { createControlPlaneState, trackLogPersist } from "./control-plane-state.ts";

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
});
