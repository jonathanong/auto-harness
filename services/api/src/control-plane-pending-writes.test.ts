import { describe, expect, it } from "vitest";

import { archiveSessionLogs } from "./control-plane-archive.ts";
import {
  createControlPlaneState,
  queueWrite,
  settleStorage,
  trackLogPersist,
} from "./control-plane-state.ts";

/**
 * settleStorage is the only thing that ever emptied these, and no production path calls
 * it — so a long-running API retained one settled promise per durable write, forever, and
 * archiving any session awaited every log write since process start.
 */
describe("pending durable writes", () => {
  it("retains nothing once writes succeed", async () => {
    const state = createControlPlaneState();

    for (let i = 0; i < 200; i += 1) await queueWrite(state, async () => {});
    // Pruning is scheduled on the write's own continuation.
    await Promise.resolve();

    expect(state.pendingPersists).toHaveLength(0);
  });

  it("keeps a failed write so settleStorage still reports it", async () => {
    const state = createControlPlaneState();

    const failed = queueWrite(state, async () => {
      throw new Error("write failed");
    });
    await failed.catch(() => undefined);

    expect(state.pendingPersists).toHaveLength(1);
    await expect(settleStorage(state)).rejects.toThrow("write failed");
    expect(state.pendingPersists).toHaveLength(0);
  });

  it("forgets a session's log writes once they succeed", async () => {
    const state = createControlPlaneState();
    let release: (() => void) | undefined;
    const write = new Promise<void>((resolve) => {
      release = resolve;
    });

    trackLogPersist(state, "session-a", write);
    expect(state.pendingLogPersists.get("session-a")?.size).toBe(1);
    release?.();
    await write;

    expect(state.pendingLogPersists.has("session-a")).toBe(false);
  });

  it("keeps a failed log write tracked so a later archive of that session sees the gap", async () => {
    // Pruning on any settlement (success or failure) let archiveSessionLogs's
    // Promise.all see an empty pending set and publish a transcript silently missing
    // the chunk the failed write never persisted. Only success may prune.
    const state = createControlPlaneState({
      archiveWriter: { putArchive: async () => undefined },
    });
    const failed = Promise.reject(new Error("log write failed"));

    trackLogPersist(state, "mine", failed);
    await failed.catch(() => undefined);

    expect(state.pendingLogPersists.get("mine")?.has(failed)).toBe(true);
    await expect(archiveSessionLogs(state, "mine")).rejects.toThrow("log write failed");
  });

  it("does not produce an unhandled rejection when a tracked write fails", async () => {
    // .finally() returns a new promise that passes the original rejection through; a
    // bare `void` on that derived promise with no .catch() was itself an unhandled
    // rejection whenever the tracked write failed, independent of whether the original
    // promise was already handled elsewhere.
    const state = createControlPlaneState();
    const seen: unknown[] = [];
    const onUnhandled = (reason: unknown) => seen.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      trackLogPersist(state, "mine", Promise.reject(new Error("log write failed")));
      // Let the rejection's microtasks — and Node's unhandled-rejection detection,
      // which runs on a later tick — actually settle before asserting.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    expect(seen).toEqual([]);
  });

  it("archives one session without waiting on another session's log writes", async () => {
    const state = createControlPlaneState({
      archiveWriter: { putArchive: async () => undefined },
    });
    // A log write for an unrelated session that never settles.
    trackLogPersist(state, "other-session", new Promise<void>(() => {}));

    await expect(archiveSessionLogs(state, "mine")).resolves.toMatchObject({
      key: "sessions/mine/logs.jsonl",
    });
  });

  it("still waits for the archived session's own log writes", async () => {
    const state = createControlPlaneState({
      archiveWriter: { putArchive: async () => undefined },
    });
    let release: (() => void) | undefined;
    trackLogPersist(
      state,
      "mine",
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );

    let settled = false;
    const archive = archiveSessionLogs(state, "mine").then((value) => {
      settled = true;
      return value;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    release?.();

    await expect(archive).resolves.toMatchObject({ key: "sessions/mine/logs.jsonl" });
  });
});
