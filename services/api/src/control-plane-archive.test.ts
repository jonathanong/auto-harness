import { describe, expect, it } from "vitest";

import { archiveSessionLogs, retrySessionArchiveIfNeeded } from "./control-plane-archive.ts";
import { createControlPlaneState } from "./control-plane-state.ts";

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
    state.pendingLogPersists.push(logWrite);

    const archive = archiveSessionLogs(state, "later-session");
    await Promise.resolve();
    expect(uploaded).toEqual([]);
    releaseLog?.();
    await expect(archive).resolves.toMatchObject({ key: "sessions/later-session/logs.jsonl" });
    expect(uploaded).toEqual(["sessions/later-session/logs.jsonl"]);
  });
});
