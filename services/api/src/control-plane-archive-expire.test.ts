import { describe, expect, it, vi } from "vitest";

import { createControlPlaneState } from "./control-plane-state.ts";
import {
  archiveRetentionElapsed,
  expiredArchiveMetadata,
  persistExpiredArchive,
} from "./control-plane-archive-expire.ts";
import type { ArchiveMetadata } from "./control-plane-types.ts";

const pending: ArchiveMetadata = {
  key: "sessions/session/logs.jsonl",
  contentType: "application/x-ndjson",
  bodyBytes: 0,
  status: "pending",
  objectStored: false,
  retryState: "pending",
  retryOrder: "order",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("archive expire persistence", () => {
  it("requires a finite retention anchor", () => {
    expect(archiveRetentionElapsed("2026-01-08T00:00:00.000Z", [undefined, "invalid"])).toBe(false);
    expect(archiveRetentionElapsed("invalid", ["2026-01-01T00:00:00.000Z"])).toBe(false);
    expect(archiveRetentionElapsed("2026-01-08T00:00:00.000Z", ["2026-01-01T00:00:00.000Z"])).toBe(
      true,
    );
  });

  it("strips retry attributes from expired metadata", () => {
    expect(expiredArchiveMetadata(pending, "now")).toEqual({
      key: pending.key,
      contentType: pending.contentType,
      bodyBytes: 0,
      status: "expired",
      objectStored: false,
      updatedAt: "now",
    });
  });

  it("does not expire a complete winner and is idempotent for expired rows", async () => {
    const state = createControlPlaneState({ now: () => "now" });
    await expect(
      persistExpiredArchive(state, pending.key, {
        ...pending,
        status: "complete",
        objectStored: true,
      }),
    ).resolves.toBe("complete");
    await expect(
      persistExpiredArchive(state, pending.key, { ...pending, status: "expired" }),
    ).resolves.toBe("expired");
    expect(state.archives.get(pending.key)?.status).toBe("expired");
  });

  it("persists through durable storage and mirrors the expired fence locally", async () => {
    const expireArchive = vi.fn(async () => true);
    const state = createControlPlaneState({
      now: () => "now",
      storage: { expireArchive, getArchive: async () => pending } as never,
    });
    await expect(persistExpiredArchive(state, pending.key, pending)).resolves.toBe("expired");
    expect(expireArchive).toHaveBeenCalledWith(pending.key, "now");
    expect(state.archives.get(pending.key)).toMatchObject({ status: "expired" });
    expect(state.archives.get(pending.key)).not.toHaveProperty("retryState");
  });

  it("treats a lost expire write according to the latest durable row", async () => {
    const expireArchive = vi.fn(async () => false);
    const complete: ArchiveMetadata = {
      ...pending,
      status: "complete",
      objectStored: true,
      versionId: "v1",
    };
    const expired: ArchiveMetadata = { ...pending, status: "expired" };
    const completeState = createControlPlaneState({
      storage: { expireArchive, getArchive: async () => complete } as never,
    });
    await expect(persistExpiredArchive(completeState, pending.key, pending)).resolves.toBe(
      "complete",
    );
    expect(completeState.archives.get(pending.key)?.status).toBe("complete");

    const expiredState = createControlPlaneState({
      storage: { expireArchive, getArchive: async () => expired } as never,
    });
    await expect(persistExpiredArchive(expiredState, pending.key, pending)).resolves.toBe(
      "expired",
    );

    const pendingState = createControlPlaneState({
      storage: { expireArchive, getArchive: async () => pending } as never,
    });
    await expect(persistExpiredArchive(pendingState, pending.key, pending)).resolves.toBe(
      "pending",
    );

    const missingState = createControlPlaneState({
      storage: { expireArchive, getArchive: async () => null } as never,
    });
    await expect(persistExpiredArchive(missingState, pending.key, pending)).resolves.toBe(
      "pending",
    );
  });

  it("expires in memory when durable expire is unavailable", async () => {
    const state = createControlPlaneState({
      now: () => "now",
      storage: { getArchive: async () => pending } as never,
    });
    await expect(persistExpiredArchive(state, pending.key, pending)).resolves.toBe("expired");
    expect(state.archives.get(pending.key)?.status).toBe("expired");
  });

  it("keeps the conservative pending state when expire persistence fails", async () => {
    const state = createControlPlaneState({
      storage: {
        expireArchive: async () => {
          throw new Error("archives unavailable");
        },
      } as never,
    });
    await expect(persistExpiredArchive(state, pending.key, pending)).resolves.toBe("pending");
    expect(state.archives.get(pending.key)).toBeUndefined();
  });

  it("does not expire an in-flight processing claim", async () => {
    const expireArchive = vi.fn(async () => true);
    const processing: ArchiveMetadata = { ...pending, retryState: "processing", bodyBytes: 42 };
    const state = createControlPlaneState({
      now: () => "now",
      storage: { expireArchive, getArchive: async () => processing } as never,
    });
    await expect(persistExpiredArchive(state, processing.key, processing)).resolves.toBe("pending");
    expect(expireArchive).not.toHaveBeenCalled();
    expect(state.archives.get(processing.key)).toMatchObject({ retryState: "processing" });

    const memory = createControlPlaneState({ now: () => "now" });
    memory.archives.set(processing.key, processing);
    await expect(persistExpiredArchive(memory, processing.key, processing)).resolves.toBe(
      "pending",
    );
    expect(memory.archives.get(processing.key)).toMatchObject({
      status: "pending",
      retryState: "processing",
    });

    const completeMemory = createControlPlaneState({ now: () => "now" });
    completeMemory.archives.set(processing.key, {
      ...processing,
      status: "complete",
      objectStored: true,
    });
    await expect(persistExpiredArchive(completeMemory, processing.key, processing)).resolves.toBe(
      "complete",
    );

    const expiredState = createControlPlaneState({
      storage: {
        expireArchive,
        getArchive: async () => ({ ...processing, status: "expired" as const }),
      } as never,
    });
    await expect(persistExpiredArchive(expiredState, processing.key, processing)).resolves.toBe(
      "expired",
    );
    expect(expireArchive).not.toHaveBeenCalled();
  });

  it("expires a processing claim that captured no logs", async () => {
    const expireArchive = vi.fn(async () => true);
    const empty: ArchiveMetadata = { ...pending, retryState: "processing" };
    const state = createControlPlaneState({
      now: () => "now",
      storage: { expireArchive, getArchive: async () => empty } as never,
    });
    await expect(persistExpiredArchive(state, empty.key, empty)).resolves.toBe("expired");
    expect(expireArchive).toHaveBeenCalledWith(empty.key, "now");
  });

  it("refuses to clobber an in-memory complete winner", async () => {
    const state = createControlPlaneState({ now: () => "now" });
    state.archives.set(pending.key, { ...pending, status: "complete", objectStored: true });
    await expect(persistExpiredArchive(state, pending.key, pending)).resolves.toBe("complete");
    expect(state.archives.get(pending.key)?.status).toBe("complete");
  });
});
