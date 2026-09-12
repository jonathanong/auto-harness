import { describe, expect, it, vi } from "vitest";

import { ControlPlane } from "./control-plane.ts";

describe("durable archive reads", () => {
  it("distinguishes terminal transcripts whose recent-log retention has expired", async () => {
    const plane = new ControlPlane({ now: () => "2026-01-08T00:00:00.000Z" });
    const key = "sessions/session/logs.jsonl";
    plane.state.archives.set(key, {
      key,
      contentType: "application/x-ndjson",
      bodyBytes: 42,
      status: "pending",
      objectStored: false,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    plane.state.logs.set(key.split("/")[1]!, [
      {
        sessionId: "session",
        timestampSeq: "2026-01-01T00:00:00.000Z#000000000001",
        timestamp: "2026-01-01T00:00:00.000Z",
        stream: "stdout",
        content: "retained",
        seq: 1,
      },
    ]);

    await expect(
      plane.getArchiveDownloadDurable("session", "2026-01-01T00:00:00.000Z"),
    ).resolves.toEqual({ state: "dynamodb" });
    plane.state.logs.delete("session");
    plane.state.archives.delete(key);
    await expect(
      plane.getArchiveDownloadDurable("session", "2026-01-01T00:00:00.000Z"),
    ).resolves.toEqual({ state: "expired" });
    await expect(plane.getArchiveDownloadDurable("session", "invalid")).resolves.toEqual({
      state: "dynamodb",
    });
  });

  it("exposes an integrity-incomplete transcript without signing it", async () => {
    const plane = new ControlPlane({
      archiveReader: {
        createDownload: async ({ versionId }) => {
          expect(versionId).toBe("archive-v1");
          return { available: false, reason: "content-length-mismatch" };
        },
      },
    });
    plane.state.archives.set("sessions/session/logs.jsonl", {
      key: "sessions/session/logs.jsonl",
      versionId: "archive-v1",
      contentType: "application/x-ndjson",
      bodyBytes: 42,
      status: "complete",
      objectStored: true,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    await expect(plane.getArchiveDownloadDurable("session")).resolves.toEqual({
      state: "incomplete",
      reason: "content-length-mismatch",
    });
  });

  it("withholds legacy complete rows that have no persisted S3 version", async () => {
    const createDownload = vi.fn();
    const plane = new ControlPlane({ archiveReader: { createDownload } });
    plane.state.archives.set("sessions/session/logs.jsonl", {
      key: "sessions/session/logs.jsonl",
      contentType: "application/x-ndjson",
      bodyBytes: 42,
      status: "complete",
      objectStored: true,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    await expect(plane.getArchiveDownloadDurable("session")).resolves.toEqual({
      state: "incomplete",
      reason: "version-id-missing",
    });
    expect(createDownload).not.toHaveBeenCalled();
  });

  it("uses one bounded durable log read before declaring an old row expired", async () => {
    const queryLogs = vi
      .fn(async (_sessionId: string, query: { limit: number; consistentRead: boolean }) => {
        expect(query).toEqual({ limit: 1, consistentRead: true });
        return [];
      })
      .mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error("read unavailable"));
    const plane = new ControlPlane({
      now: () => "2026-01-08T00:00:00.000Z",
      storage: { getArchive: async () => null, queryLogs } as never,
    });

    await expect(
      plane.getArchiveDownloadDurable("session", "2026-01-01T00:00:00.000Z"),
    ).resolves.toEqual({ state: "dynamodb" });
    await expect(
      plane.getArchiveDownloadDurable("session", "2026-01-01T00:00:00.000Z"),
    ).resolves.toEqual({ state: "expired" });
    await expect(
      plane.getArchiveDownloadDurable("session", "2026-01-01T00:00:00.000Z"),
    ).resolves.toEqual({ state: "dynamodb" });
    expect(queryLogs).toHaveBeenCalledTimes(3);
  });
});
