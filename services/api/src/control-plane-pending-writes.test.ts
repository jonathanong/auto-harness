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

  it("forgets a session's log writes once they settle", async () => {
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
