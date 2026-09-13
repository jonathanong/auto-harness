/* eslint-disable max-lines -- replacement races cover durable and in-memory generations. */
import { describe, expect, it, vi } from "vitest";

import {
  archiveSessionLogs,
  getArchiveDownloadDurable,
  retrySessionArchiveIfNeeded,
} from "./control-plane-archive.ts";
import { queueLegacyArchiveRetry } from "./control-plane-archive-replace.ts";
import { createControlPlaneState } from "./control-plane-state.ts";
import type { ArchiveMetadata } from "./control-plane-types.ts";

function storedComplete(sessionId: string, versionId?: string): ArchiveMetadata {
  const key = `sessions/${sessionId}/logs.jsonl`;
  return {
    key,
    contentType: "application/x-ndjson",
    bodyBytes: 12,
    status: "complete",
    objectStored: true,
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...(versionId ? { versionId } : {}),
  };
}

function downloadReader(signed: string[]) {
  return {
    createDownload: async ({ versionId }: { versionId: string }) => {
      signed.push(versionId);
      return {
        available: true as const,
        downloadUrl: `https://archive.example.test/${versionId}`,
        expiresAt: "2026-01-01T00:05:00.000Z",
      };
    },
  };
}

describe("archive replacement preserves the last complete generation", () => {
  it("keeps the last complete version downloadable when replacement upload fails", async () => {
    const signed: string[] = [];
    const putArchive = vi.fn(async () => undefined);
    const state = createControlPlaneState({
      archiveWriter: {
        putArchive: async () => {
          throw new Error("object store unavailable");
        },
      },
      archiveReader: downloadReader(signed),
      storage: {
        getArchive: async () => storedComplete("replace-fail", "complete-v1"),
        listLogs: async () => [],
        putArchive,
      } as never,
    });

    await expect(archiveSessionLogs(state, "replace-fail")).rejects.toThrow(
      "object store unavailable",
    );
    expect(putArchive).not.toHaveBeenCalled();
    expect(state.archives.get("sessions/replace-fail/logs.jsonl")).toMatchObject({
      status: "complete",
      objectStored: true,
      versionId: "complete-v1",
    });
    await expect(getArchiveDownloadDurable(state, "replace-fail")).resolves.toMatchObject({
      state: "archived",
      downloadUrl: "https://archive.example.test/complete-v1",
    });
    expect(signed).toEqual(["complete-v1"]);
  });

  it("publishes replacement metadata only after the new version is stored", async () => {
    const signed: string[] = [];
    const state = createControlPlaneState({
      archiveWriter: { putArchive: async () => ({ versionId: "complete-v2" }) },
      archiveReader: downloadReader(signed),
      now: () => "2026-01-02T00:00:00.000Z",
    });
    state.archives.set(
      "sessions/replace-ok/logs.jsonl",
      storedComplete("replace-ok", "complete-v1"),
    );

    await archiveSessionLogs(state, "replace-ok");
    expect(state.archives.get("sessions/replace-ok/logs.jsonl")).toMatchObject({
      status: "complete",
      objectStored: true,
      versionId: "complete-v2",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    await expect(getArchiveDownloadDurable(state, "replace-ok")).resolves.toMatchObject({
      state: "archived",
      downloadUrl: "https://archive.example.test/complete-v2",
    });
    expect(signed).toEqual(["complete-v2"]);
  });

  it("does not publish a stale replacement over a newer complete winner", async () => {
    let releaseUpload!: () => void;
    const firstUploadGate = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    let firstUploadStarted!: () => void;
    const firstUploadReady = new Promise<void>((resolve) => {
      firstUploadStarted = resolve;
    });
    let uploads = 0;
    const key = "sessions/replace-race/logs.jsonl";
    const state = createControlPlaneState({
      archiveWriter: {
        putArchive: async () => {
          uploads += 1;
          if (uploads === 1) {
            firstUploadStarted();
            await firstUploadGate;
            return { versionId: "stale-v" };
          }
          return { versionId: "winner-v" };
        },
      },
    });
    state.archives.set(key, storedComplete("replace-race", "complete-v1"));

    const stale = archiveSessionLogs(state, "replace-race");
    await firstUploadReady;
    await archiveSessionLogs(state, "replace-race");
    releaseUpload();
    await stale;

    expect(state.archives.get(key)?.versionId).toBe("winner-v");
  });

  it("does not publish stale replacement metadata when the durable generation loses", async () => {
    const key = "sessions/replace-durable/logs.jsonl";
    const putArchive = vi.fn(async () => undefined);
    const replaceCompleteArchive = vi.fn(async () => false);
    const current = storedComplete("replace-durable", "complete-v1");
    const state = createControlPlaneState({
      archiveWriter: { putArchive: async () => ({ versionId: "stale-v" }) },
      storage: {
        getArchive: async () => current,
        listLogs: async () => [],
        putArchive,
        replaceCompleteArchive,
      } as never,
    });

    await archiveSessionLogs(state, "replace-durable");
    expect(replaceCompleteArchive).toHaveBeenCalledWith(
      expect.objectContaining({ versionId: "stale-v" }),
      { versionId: "complete-v1", updatedAt: current.updatedAt },
    );
    expect(putArchive).not.toHaveBeenCalled();
    expect(state.archives.get(key)?.versionId).toBe("complete-v1");
  });

  it("commits a winning durable replacement without an unconditional put", async () => {
    const putArchive = vi.fn(async () => undefined);
    const replaceCompleteArchive = vi.fn(async () => true);
    const state = createControlPlaneState({
      archiveWriter: { putArchive: async () => ({ versionId: "complete-v2" }) },
      storage: {
        getArchive: async () => storedComplete("replace-commit", "complete-v1"),
        listLogs: async () => [],
        putArchive,
        replaceCompleteArchive,
      } as never,
    });

    await archiveSessionLogs(state, "replace-commit");
    expect(replaceCompleteArchive).toHaveBeenCalledOnce();
    expect(putArchive).not.toHaveBeenCalled();
    expect(state.archives.get("sessions/replace-commit/logs.jsonl")?.versionId).toBe("complete-v2");
  });

  it("leaves the previous complete row when a replacement upload has no version id", async () => {
    const state = createControlPlaneState({
      archiveWriter: { putArchive: async () => undefined },
    });
    state.archives.set(
      "sessions/replace-no-version/logs.jsonl",
      storedComplete("replace-no-version", "complete-v1"),
    );

    await archiveSessionLogs(state, "replace-no-version");
    expect(state.archives.get("sessions/replace-no-version/logs.jsonl")?.versionId).toBe(
      "complete-v1",
    );
  });

  it("does not displace a complete archive when deferring without a writer", async () => {
    const putArchive = vi.fn(async () => undefined);
    const current = storedComplete("ws-complete", "complete-v1");
    const state = createControlPlaneState({
      storage: { getArchive: async () => current, putArchive, listLogs: async () => [] } as never,
    });

    const object = await archiveSessionLogs(state, "ws-complete", undefined, true);
    expect(object.body).toBe("");
    expect(putArchive).not.toHaveBeenCalled();
    expect(state.archives.get(current.key)).toEqual(current);
  });

  it("does not overwrite a stored complete archive when no writer is configured", async () => {
    const state = createControlPlaneState();
    const current = storedComplete("local-complete", "complete-v1");
    state.archives.set(current.key, current);

    await archiveSessionLogs(state, "local-complete");
    expect(state.archives.get(current.key)).toEqual(current);
  });

  it("does not put a stale replacement when a later complete generation already won", async () => {
    const putArchive = vi.fn(async () => undefined);
    let reads = 0;
    const state = createControlPlaneState({
      archiveWriter: { putArchive: async () => ({ versionId: "stale-v" }) },
      storage: {
        getArchive: async () =>
          reads++ === 0
            ? storedComplete("replace-fallback", "complete-v1")
            : storedComplete("replace-fallback", "winner-v"),
        listLogs: async () => [],
        putArchive,
      } as never,
    });

    await archiveSessionLogs(state, "replace-fallback");
    expect(putArchive).not.toHaveBeenCalled();
    expect(state.archives.get("sessions/replace-fallback/logs.jsonl")?.versionId).toBe(
      "complete-v1",
    );
  });

  it("puts a matching in-memory generation when durable replacement fencing is unavailable", async () => {
    const putArchive = vi.fn(async () => undefined);
    const current = storedComplete("replace-put", "complete-v1");
    const state = createControlPlaneState({
      archiveWriter: { putArchive: async () => ({ versionId: "complete-v2" }) },
      now: () => "2026-01-02T00:00:00.000Z",
      storage: {
        getArchive: async () => current,
        listLogs: async () => [],
        putArchive,
      } as never,
    });

    await archiveSessionLogs(state, "replace-put");
    expect(putArchive).toHaveBeenCalledWith(
      expect.objectContaining({ versionId: "complete-v2", status: "complete" }),
    );
  });

  it("repairs a legacy complete winner through a fenced replacement", async () => {
    const key = "sessions/legacy-replace-repair/logs.jsonl";
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
    const complete = storedComplete("legacy-replace-repair");
    let reads = 0;
    const replaceCompleteArchive = vi.fn(async () => true);
    const putArchive = vi.fn(async () => undefined);
    const state = createControlPlaneState({
      archiveWriter: { putArchive: async () => ({ versionId: "repaired-v1" }) },
      storage: {
        getArchive: async () => (reads++ === 0 ? pending : complete),
        listLogs: async () => [{ timestamp: "1", stream: "stdout", content: "legacy" }],
        completeArchiveRetry: async () => false,
        putArchive,
        replaceCompleteArchive,
      } as never,
    });

    await retrySessionArchiveIfNeeded(state, "legacy-replace-repair", {
      retryState: "processing",
      retryOrder: "claim-order",
    });
    expect(replaceCompleteArchive).toHaveBeenCalledWith(
      expect.objectContaining({ versionId: "repaired-v1" }),
      { updatedAt: complete.updatedAt },
    );
    expect(putArchive).not.toHaveBeenCalled();
    expect(state.archives.get(key)).toMatchObject({ versionId: "repaired-v1" });
  });

  it("still writes a pending row for a first-time archive", async () => {
    const putArchive = vi.fn(async () => undefined);
    const state = createControlPlaneState({
      archiveWriter: { putArchive: async () => ({ versionId: "first-v1" }) },
      storage: {
        getArchive: async () => null,
        listLogs: async () => [],
        putArchive,
      } as never,
    });

    await archiveSessionLogs(state, "first-complete");
    expect(putArchive).toHaveBeenCalledWith(expect.objectContaining({ status: "pending" }));
    expect(putArchive).toHaveBeenCalledWith(
      expect.objectContaining({ status: "complete", versionId: "first-v1" }),
    );
  });

  it("writes a retryable pending row when a legacy no-version complete upload fails", async () => {
    const putArchive = vi.fn(async () => undefined);
    const state = createControlPlaneState({
      archiveWriter: {
        putArchive: async () => {
          throw new Error("object store unavailable");
        },
      },
      storage: {
        getArchive: async () => storedComplete("legacy-fail"),
        listLogs: async () => [],
        putArchive,
      } as never,
    });

    await expect(archiveSessionLogs(state, "legacy-fail")).rejects.toThrow(
      "object store unavailable",
    );
    expect(putArchive).toHaveBeenCalledWith(
      expect.objectContaining({ status: "pending", objectStored: false }),
    );
    expect(state.archives.get("sessions/legacy-fail/logs.jsonl")).toMatchObject({
      status: "pending",
      objectStored: false,
    });
  });

  it("does not queue a legacy retry over a later version-pinned complete generation", async () => {
    const putArchive = vi.fn(async () => undefined);
    let reads = 0;
    const state = createControlPlaneState({
      archiveWriter: {
        putArchive: async () => {
          throw new Error("object store unavailable");
        },
      },
      storage: {
        getArchive: async () =>
          reads++ === 0 ? storedComplete("legacy-race") : storedComplete("legacy-race", "winner-v"),
        listLogs: async () => [],
        putArchive,
      } as never,
    });

    await expect(archiveSessionLogs(state, "legacy-race")).resolves.toMatchObject({
      key: "sessions/legacy-race/logs.jsonl",
    });
    expect(putArchive).not.toHaveBeenCalled();
  });

  it("queues a fenced legacy retry through replaceCompleteArchivePending", async () => {
    const putArchive = vi.fn(async () => undefined);
    const replaceCompleteArchivePending = vi.fn(async () => true);
    const current = storedComplete("legacy-pending");
    const state = createControlPlaneState({
      archiveWriter: {
        putArchive: async () => {
          throw new Error("object store unavailable");
        },
      },
      storage: {
        getArchive: async () => current,
        listLogs: async () => [],
        putArchive,
        replaceCompleteArchivePending,
      } as never,
    });

    await expect(archiveSessionLogs(state, "legacy-pending")).rejects.toThrow(
      "object store unavailable",
    );
    expect(replaceCompleteArchivePending).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "pending",
        objectStored: false,
        retryState: "processing",
      }),
      { updatedAt: current.updatedAt },
    );
    expect(putArchive).not.toHaveBeenCalled();
    expect(state.archives.get(current.key)).toMatchObject({
      status: "pending",
      objectStored: false,
      retryState: "processing",
    });
  });

  it("records a fenced legacy retry before awaiting the object PUT", async () => {
    let releasePut!: () => void;
    let markPutStarted!: () => void;
    const putStarted = new Promise<void>((resolve) => {
      markPutStarted = resolve;
    });
    const putReleased = new Promise<void>((resolve) => {
      releasePut = resolve;
    });
    const replaceCompleteArchivePending = vi.fn(async () => true);
    const completeArchiveRetry = vi.fn(async () => true);
    const current = storedComplete("legacy-hang");
    const state = createControlPlaneState({
      archiveWriter: {
        putArchive: async () => {
          markPutStarted();
          await putReleased;
          return { versionId: "repaired-v" };
        },
      },
      storage: {
        getArchive: async () => current,
        listLogs: async () => [],
        replaceCompleteArchivePending,
        completeArchiveRetry,
      } as never,
    });

    const archived = archiveSessionLogs(state, "legacy-hang");
    await putStarted;
    expect(replaceCompleteArchivePending).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "pending",
        objectStored: false,
        retryState: "processing",
      }),
      { updatedAt: current.updatedAt },
    );
    expect(state.archives.get(current.key)).toMatchObject({
      status: "pending",
      objectStored: false,
      retryState: "processing",
    });
    expect(completeArchiveRetry).not.toHaveBeenCalled();
    releasePut();
    await archived;
    expect(completeArchiveRetry).toHaveBeenCalledWith(
      expect.objectContaining({ status: "complete", versionId: "repaired-v" }),
      expect.any(String),
    );
    expect(state.archives.get(current.key)).toMatchObject({
      status: "complete",
      versionId: "repaired-v",
    });
  });

  it("replaces a legacy complete row after the new version commits", async () => {
    const putArchive = vi.fn(async () => undefined);
    const current = storedComplete("legacy-ok");
    const state = createControlPlaneState({
      archiveWriter: { putArchive: async () => ({ versionId: "repaired-v2" }) },
      storage: {
        getArchive: async () => current,
        listLogs: async () => [],
        putArchive,
      } as never,
    });

    await archiveSessionLogs(state, "legacy-ok");
    expect(putArchive).toHaveBeenCalledWith(
      expect.objectContaining({ status: "pending", objectStored: false, retryState: "processing" }),
    );
    expect(putArchive).toHaveBeenCalledWith(
      expect.objectContaining({ status: "complete", versionId: "repaired-v2" }),
    );
  });

  it("does not put a replacement when the stored row is no longer complete", async () => {
    const putArchive = vi.fn(async () => undefined);
    let reads = 0;
    const state = createControlPlaneState({
      archiveWriter: { putArchive: async () => ({ versionId: "stale-v" }) },
      storage: {
        getArchive: async () =>
          reads++ === 0
            ? storedComplete("replace-pending", "complete-v1")
            : {
                ...storedComplete("replace-pending", "complete-v1"),
                status: "pending" as const,
                objectStored: false,
              },
        listLogs: async () => [],
        putArchive,
      } as never,
    });

    await archiveSessionLogs(state, "replace-pending");
    expect(putArchive).not.toHaveBeenCalled();
  });

  it("uses cached complete metadata when durable storage has no point lookup", async () => {
    const putArchive = vi.fn(async () => undefined);
    const state = createControlPlaneState({
      archiveWriter: { putArchive: async () => ({ versionId: "complete-v2" }) },
      storage: { listLogs: async () => [], putArchive } as never,
    });
    state.archives.set(
      "sessions/replace-cache/logs.jsonl",
      storedComplete("replace-cache", "complete-v1"),
    );

    await archiveSessionLogs(state, "replace-cache");
    expect(putArchive).toHaveBeenCalledWith(expect.objectContaining({ versionId: "complete-v2" }));
  });

  it("treats a missing in-memory archive as a first-time pending upload", async () => {
    const putArchive = vi.fn(async () => undefined);
    const state = createControlPlaneState({
      archiveWriter: { putArchive: async () => ({ versionId: "first-v1" }) },
      storage: { listLogs: async () => [], putArchive } as never,
    });

    await archiveSessionLogs(state, "first-cache");
    expect(putArchive).toHaveBeenCalledWith(expect.objectContaining({ status: "pending" }));
  });

  it("queues an in-memory legacy retry before the object PUT", async () => {
    const current = storedComplete("legacy-mem");
    const state = createControlPlaneState({
      archiveWriter: {
        putArchive: async () => {
          throw new Error("object store unavailable");
        },
      },
    });
    state.archives.set(current.key, current);

    await expect(archiveSessionLogs(state, "legacy-mem")).rejects.toThrow(
      "object store unavailable",
    );
    expect(state.archives.get(current.key)).toMatchObject({
      status: "pending",
      objectStored: false,
    });
  });

  it("leaves a complete row when a fenced legacy retry loses", async () => {
    const putArchive = vi.fn(async () => undefined);
    const current = storedComplete("legacy-lost");
    const state = createControlPlaneState({
      archiveWriter: {
        putArchive: async () => {
          throw new Error("object store unavailable");
        },
      },
      storage: {
        getArchive: async () => current,
        listLogs: async () => [],
        putArchive,
        replaceCompleteArchivePending: async () => false,
      } as never,
    });

    await expect(archiveSessionLogs(state, "legacy-lost")).resolves.toMatchObject({
      key: current.key,
    });
    expect(putArchive).not.toHaveBeenCalled();
    expect(state.archives.get(current.key)).toEqual(current);
  });

  it("does not queue a version-pinned generation as a legacy retry", async () => {
    const putArchive = vi.fn(async () => undefined);
    const current = storedComplete("legacy-pinned", "complete-v1");
    const state = createControlPlaneState({
      storage: { getArchive: async () => current, putArchive } as never,
    });
    await expect(
      queueLegacyArchiveRetry(
        state,
        {
          ...current,
          status: "pending",
          objectStored: false,
        },
        { versionId: "complete-v1", updatedAt: current.updatedAt },
      ),
    ).resolves.toBe(false);
    expect(putArchive).not.toHaveBeenCalled();
  });
});
