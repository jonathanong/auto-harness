import { describe, expect, it, vi } from "vitest";

import {
  cancelQueuedSession,
  expireQueuedSession,
  failExpiredResumeSession,
  finishSession,
  requeueUsageLimitedSession,
  suppressProviderlessUsageLimit,
  tryAssignSession,
} from "./plane-storage-sessions.ts";
import { assignmentLeaseCollision, type PlaneStorageCtx } from "./plane-storage-types.ts";

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

function cancelled(failedIndex: number, extraFailed?: number) {
  return Object.assign(new Error("canceled"), {
    name: "TransactionCanceledException",
    CancellationReasons: Array.from({ length: 8 }, (_, index) => ({
      Code: index === failedIndex || index === extraFailed ? "ConditionalCheckFailed" : "None",
    })),
  });
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

  it("treats requeue and suppress condition losses as claim losses and rethrows other errors", async () => {
    const item = { Item: { id: "session", status: "running", createdAt: "now", priority: 0 } };
    const requeue = {
      sessionId: "session",
      worktreeId: "worktree",
      attemptId: "attempt",
      providerAccountId: "account",
      queueShard: 0,
      now: "now",
      usageLimitedUntil: "later",
      errorMessage: "quota",
    };
    const suppress = {
      sessionId: "session",
      worktreeId: "worktree",
      attemptId: "attempt",
      queueShard: 0,
      targetIndex: 0,
    };
    const lostRequeue = vi.fn().mockResolvedValueOnce(item).mockRejectedValueOnce(conditional);
    await expect(requeueUsageLimitedSession(ctx(lostRequeue), requeue)).resolves.toBe(false);
    const lostSuppress = vi.fn().mockResolvedValueOnce(item).mockRejectedValueOnce(conditional);
    await expect(suppressProviderlessUsageLimit(ctx(lostSuppress), suppress)).resolves.toBe(false);
    const boomRequeue = vi
      .fn()
      .mockResolvedValueOnce(item)
      .mockRejectedValueOnce(new Error("dynamo unavailable"));
    await expect(requeueUsageLimitedSession(ctx(boomRequeue), requeue)).rejects.toThrow(
      "dynamo unavailable",
    );
    const boomSuppress = vi
      .fn()
      .mockResolvedValueOnce(item)
      .mockRejectedValueOnce(new Error("dynamo unavailable"));
    await expect(suppressProviderlessUsageLimit(ctx(boomSuppress), suppress)).rejects.toThrow(
      "dynamo unavailable",
    );
  });

  it("retries only a sole provider-lease Put collision", async () => {
    const assignOpts = {
      sessionId: "session",
      repositoryId: "repo",
      worktreeId: "worktree",
      hostId: "host",
      hostInventoryVersion: null,
      connectionId: "connection",
      now: "now",
      attemptId: "attempt",
      resolvedArgv: ["echo"],
      resolvedRoute: {
        targetIndex: 0,
        commandId: "command",
        hostId: "host",
        worktreeId: "worktree",
        attemptId: "attempt",
      },
      providerAccountId: "account",
      providerAccountLease: {
        concurrencyId: "acct:account:0",
        providerAccountId: "account",
        slot: 0,
        attemptId: "attempt",
      },
      queueShard: 0,
    };
    const collision = vi.fn(async (command: { input?: { TransactItems?: unknown[] } }) => {
      const leaseIndex = (command.input?.TransactItems ?? []).length - 1;
      throw cancelled(leaseIndex);
    });
    await expect(tryAssignSession(ctx(collision), assignOpts)).resolves.toBe("lease_collision");
    const doomed = vi.fn(async (command: { input?: { TransactItems?: unknown[] } }) => {
      const leaseIndex = (command.input?.TransactItems ?? []).length - 1;
      throw cancelled(leaseIndex, 3);
    });
    await expect(tryAssignSession(ctx(doomed), assignOpts)).resolves.toBe(false);
    expect(assignmentLeaseCollision(cancelled(7), undefined)).toBe(false);
    expect(assignmentLeaseCollision(new Error("unavailable"), 0)).toBe(false);
  });
});
