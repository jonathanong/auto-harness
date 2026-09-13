import { describe, expect, it, vi } from "vitest";

import { ControlPlane } from "./control-plane.ts";

describe("durable archive expiry reads", () => {
  it("persists a pending archive as expired before reporting data loss", async () => {
    const plane = new ControlPlane({ now: () => "2026-01-08T00:00:00.000Z" });
    const key = "sessions/session/logs.jsonl";
    plane.state.archives.set(key, {
      key,
      contentType: "application/x-ndjson",
      bodyBytes: 42,
      status: "pending",
      objectStored: false,
      retryState: "pending",
      retryOrder: "2026-01-01T00:00:00.000Z#sessions/session/logs.jsonl",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    await expect(
      plane.getArchiveDownloadDurable("session", "2026-01-01T00:00:00.000Z"),
    ).resolves.toEqual({ state: "expired" });
    expect(plane.state.archives.get(key)).toMatchObject({
      status: "expired",
      objectStored: false,
    });
    expect(plane.state.archives.get(key)).not.toHaveProperty("retryState");
    expect(plane.state.archives.get(key)).not.toHaveProperty("retryOrder");
  });

  it("returns a durable expired row without probing recent logs again", async () => {
    const queryLogs = vi.fn(async () => []);
    const plane = new ControlPlane({
      storage: {
        getArchive: async () => ({
          key: "sessions/session/logs.jsonl",
          contentType: "application/x-ndjson",
          bodyBytes: 0,
          status: "expired",
          objectStored: false,
          updatedAt: "2026-01-08T00:00:00.000Z",
        }),
        queryLogs,
      } as never,
    });

    await expect(plane.getArchiveDownloadDurable("session")).resolves.toEqual({
      state: "expired",
    });
    expect(queryLogs).not.toHaveBeenCalled();
  });

  it("writes durable expiry before returning expired from a storage-backed read", async () => {
    const expireArchive = vi.fn(async () => true);
    const queryLogs = vi.fn(async () => []);
    const plane = new ControlPlane({
      now: () => "2026-01-08T00:00:00.000Z",
      storage: {
        getArchive: async () => ({
          key: "sessions/session/logs.jsonl",
          contentType: "application/x-ndjson",
          bodyBytes: 0,
          status: "pending",
          objectStored: false,
          retryState: "pending",
          retryOrder: "order",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
        queryLogs,
        expireArchive,
      } as never,
    });

    await expect(plane.getArchiveDownloadDurable("session")).resolves.toEqual({
      state: "expired",
    });
    expect(queryLogs).toHaveBeenCalledOnce();
    expect(expireArchive).toHaveBeenCalledWith(
      "sessions/session/logs.jsonl",
      "2026-01-08T00:00:00.000Z",
    );
  });

  it("does not expire an in-flight processing claim that already captured logs", async () => {
    const expireArchive = vi.fn(async () => true);
    const queryLogs = vi.fn(async () => []);
    const plane = new ControlPlane({
      now: () => "2026-01-08T00:00:00.000Z",
      storage: {
        getArchive: async () => ({
          key: "sessions/session/logs.jsonl",
          contentType: "application/x-ndjson",
          bodyBytes: 42,
          status: "pending",
          objectStored: false,
          retryState: "processing",
          retryOrder: "claim",
          capturedRetryOrder: "claim",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
        queryLogs,
        expireArchive,
      } as never,
    });

    await expect(plane.getArchiveDownloadDurable("session")).resolves.toEqual({
      state: "dynamodb",
    });
    expect(queryLogs).toHaveBeenCalledOnce();
    expect(expireArchive).not.toHaveBeenCalled();
  });

  it("does not report expired when a concurrent complete wins the durable fence", async () => {
    const expireArchive = vi.fn(async () => false);
    const plane = new ControlPlane({
      now: () => "2026-01-08T00:00:00.000Z",
      archiveReader: {
        createDownload: async () => ({
          available: true,
          downloadUrl: "https://example.com/logs.jsonl",
          expiresAt: "2026-01-08T00:05:00.000Z",
        }),
      },
      storage: {
        getArchive: vi
          .fn()
          .mockResolvedValueOnce({
            key: "sessions/session/logs.jsonl",
            contentType: "application/x-ndjson",
            bodyBytes: 4,
            status: "pending",
            objectStored: false,
            retryState: "processing",
            retryOrder: "claim",
            capturedRetryOrder: "claim",
            updatedAt: "2026-01-01T00:00:00.000Z",
          })
          .mockResolvedValueOnce({
            key: "sessions/session/logs.jsonl",
            contentType: "application/x-ndjson",
            bodyBytes: 4,
            status: "complete",
            objectStored: true,
            versionId: "archive-v1",
            updatedAt: "2026-01-08T00:00:00.000Z",
          }),
        queryLogs: async () => [],
        expireArchive,
      } as never,
    });

    await expect(plane.getArchiveDownloadDurable("session")).resolves.toEqual({
      state: "archived",
      downloadUrl: "https://example.com/logs.jsonl",
      expiresAt: "2026-01-08T00:05:00.000Z",
      contentType: "application/x-ndjson",
      bodyBytes: 4,
    });
    expect(expireArchive).not.toHaveBeenCalled();
  });

  it("stays on the recent-log path when expire persistence fails", async () => {
    const plane = new ControlPlane({
      now: () => "2026-01-08T00:00:00.000Z",
      storage: {
        getArchive: async () => ({
          key: "sessions/session/logs.jsonl",
          contentType: "application/x-ndjson",
          bodyBytes: 0,
          status: "pending",
          objectStored: false,
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
        queryLogs: async () => [],
        expireArchive: async () => {
          throw new Error("archives unavailable");
        },
      } as never,
    });

    await expect(plane.getArchiveDownloadDurable("session")).resolves.toEqual({
      state: "dynamodb",
    });
  });
});
