import { describe, expect, it, vi } from "vitest";

import {
  cancelQueuedSession,
  expireQueuedSession,
  failExpiredResumeSession,
  finishSession,
} from "./plane-storage-sessions.ts";
import type { PlaneStorageCtx } from "./plane-storage-types.ts";

const conditional = Object.assign(new Error("lost"), {
  name: "ConditionalCheckFailedException",
});

function ctx(send: ReturnType<typeof vi.fn>): PlaneStorageCtx {
  return {
    doc: { send } as never,
    tables: {
      sessions: "Sessions",
      worktrees: "Worktrees",
      concurrencyLocks: "ConcurrencyLocks",
      sessionDrainActivity: "SessionDrainActivity",
    } as never,
  } as PlaneStorageCtx;
}

describe("session storage conditional outcomes", () => {
  it("returns false when queued terminal transitions lose their condition", async () => {
    for (const operation of [
      (storage: PlaneStorageCtx) =>
        failExpiredResumeSession(storage, {
          sessionId: "session",
          queueShard: 0,
          pinExpiresAt: "expiry",
        }),
      (storage: PlaneStorageCtx) =>
        cancelQueuedSession(storage, {
          sessionId: "session",
          queueShard: 0,
          completedAt: "done",
          errorMessage: "cancelled",
        }),
      (storage: PlaneStorageCtx) =>
        expireQueuedSession(storage, {
          sessionId: "session",
          queueShard: 0,
          queueExpiresAt: "expiry",
          completedAt: "done",
        }),
    ]) {
      const send = vi.fn().mockResolvedValueOnce({}).mockRejectedValueOnce(conditional);
      await expect(operation(ctx(send))).resolves.toBe(false);
    }
  });

  it("recognizes an already-committed terminal state after a transaction race", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(conditional)
      .mockResolvedValueOnce({ Item: { id: "session", status: "completed" } });
    await expect(
      finishSession(ctx(send), {
        sessionId: "session",
        worktreeId: null,
        attemptId: "attempt",
        status: "completed",
        queueShard: 0,
        completedAt: "done",
      }),
    ).resolves.toBe(true);
  });
});
