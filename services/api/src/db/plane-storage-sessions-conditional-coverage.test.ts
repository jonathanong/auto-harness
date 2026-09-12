/* eslint-disable max-lines -- conditional transaction outcomes share one fixture. */
import { describe, expect, it, vi } from "vitest";

import {
  cancelQueuedSession,
  cancelRunningSession,
  expireQueuedSession,
  failExpiredResumeSession,
  finishSession,
  requeueUsageLimitedSession,
  requeueUsageLimitedWorkspaceSession,
  suppressProviderlessUsageLimit,
  suppressProviderlessUsageLimitWorkspace,
  tryAssignSession,
} from "./plane-storage-sessions.ts";
import { tryAssignMainCheckoutSession } from "./plane-storage-main-checkout.ts";
import { tryRequeueSession } from "./plane-storage-sessions-requeue.ts";
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
      hostLocks: "HostLocks",
      workspaceSlots: "WorkspaceSlots",
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
  it("builds cancellation fences for workspace and worktree-less assignments", async () => {
    const send = vi.fn().mockResolvedValue({});
    await expect(
      cancelRunningSession(ctx(send), {
        sessionId: "workspace",
        worktreeId: null,
        workspaceSlotId: "slot",
        hostId: "host",
        connectionId: "connection",
        attemptId: "attempt",
        queueShard: 0,
        completedAt: "done",
        errorMessage: "cancelled",
      }),
    ).resolves.toBe(true);
    await expect(
      cancelRunningSession(ctx(send), {
        sessionId: "main-checkout",
        hostId: "host",
        connectionId: "connection",
        attemptId: "attempt",
        queueShard: 0,
        completedAt: "done",
        errorMessage: "cancelled",
      }),
    ).resolves.toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
  });

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
    const failure = new Error("resume pin update failed");
    const boom = vi.fn().mockResolvedValueOnce({}).mockRejectedValueOnce(failure);
    await expect(
      failExpiredResumeSession(ctx(boom), {
        sessionId: "session",
        queueShard: 0,
        pinExpiresAt: "expiry",
      }),
    ).rejects.toBe(failure);
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
    const committed = vi.fn().mockResolvedValue({});
    await expect(requeueUsageLimitedSession(ctx(committed), requeue)).resolves.toBe(true);
    await expect(
      requeueUsageLimitedSession(ctx(vi.fn().mockResolvedValue({})), {
        ...requeue,
        hostAssignmentLease: { hostId: "host" },
      }),
    ).resolves.toBe(true);
    const sessionUpdate = committed.mock.calls[1][0].input.TransactItems.find(
      (entry: { Update?: { Key?: { id?: string } } }) => entry.Update?.Key?.id === "session",
    )?.Update?.UpdateExpression as string;
    expect(sessionUpdate).toContain("REMOVE");
    expect(sessionUpdate).toContain("assignmentConnectionId");
    expect(sessionUpdate).toContain("assignmentSentAt");

    const workspaceSuppress = {
      sessionId: "workspace-session",
      workspaceSlotId: "workspace-slot",
      attemptId: "workspace-attempt",
      queueShard: 0,
      targetIndex: 1,
    };
    const lostWorkspaceSuppress = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(conditional);
    await expect(
      suppressProviderlessUsageLimitWorkspace(ctx(lostWorkspaceSuppress), workspaceSuppress),
    ).resolves.toBe(false);
    const failedWorkspaceSuppress = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("dynamo unavailable"));
    await expect(
      suppressProviderlessUsageLimitWorkspace(ctx(failedWorkspaceSuppress), workspaceSuppress),
    ).rejects.toThrow("dynamo unavailable");

    const committedWorkspaceSuppress = vi.fn().mockResolvedValue({});
    await expect(
      suppressProviderlessUsageLimitWorkspace(ctx(committedWorkspaceSuppress), {
        ...workspaceSuppress,
        errorMessage: "workspace quota",
        workspaceSlotError: "cleanup failed",
        providerAccountLease: {
          concurrencyId: "account-lock",
          providerAccountId: "account",
          slot: 0,
          attemptId: "workspace-attempt",
        },
        hostAssignmentLease: { hostId: "host" },
      }),
    ).resolves.toBe(true);
    const workspaceWrites = committedWorkspaceSuppress.mock.calls[1][0].input
      .TransactItems as Array<{
      Update?: {
        TableName: string;
        Key: { id?: string; hostId?: string; concurrencyId?: string };
        ConditionExpression?: string;
        UpdateExpression?: string;
        ExpressionAttributeValues?: Record<string, unknown>;
      };
    }>;
    expect(workspaceWrites).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          Update: expect.objectContaining({
            TableName: "WorkspaceSlots",
            Key: { id: "workspace-slot" },
            ConditionExpression: "currentSessionId = :sid",
            UpdateExpression: expect.stringContaining("#s = :error"),
            ExpressionAttributeValues: expect.objectContaining({
              ":errorMessage": "cleanup failed",
            }),
          }),
        }),
        expect.objectContaining({
          Update: expect.objectContaining({
            TableName: "Sessions",
            Key: { id: "workspace-session" },
            ConditionExpression: expect.stringContaining("workspaceSlotId = :workspaceSlotId"),
            UpdateExpression: expect.stringContaining("suppressedTargetIndexes"),
            ExpressionAttributeValues: expect.objectContaining({
              ":message": "workspace quota",
              ":index": [1],
            }),
          }),
        }),
      ]),
    );
  });

  it("atomically cools down an account, releases its workspace slot, and requeues", async () => {
    const usageLimit = {
      sessionId: "session",
      workspaceSlotId: "slot",
      attemptId: "attempt",
      providerAccountId: "account",
      queueShard: 0,
      now: "now",
      usageLimitedUntil: "later",
      workspaceSlotError: "cleanup failed",
    };
    const lost = vi
      .fn()
      .mockResolvedValueOnce({
        Item: { id: "session", status: "running", createdAt: "now", priority: 0 },
      })
      .mockRejectedValueOnce(conditional);
    await expect(requeueUsageLimitedWorkspaceSession(ctx(lost), usageLimit)).resolves.toBe(false);

    const committed = vi.fn().mockResolvedValue({});
    await expect(requeueUsageLimitedWorkspaceSession(ctx(committed), usageLimit)).resolves.toBe(
      true,
    );
    await expect(
      requeueUsageLimitedWorkspaceSession(ctx(vi.fn().mockResolvedValue({})), {
        ...usageLimit,
        hostAssignmentLease: { hostId: "host", connectionId: "connection" },
      }),
    ).resolves.toBe(true);
    const writes = committed.mock.calls[1]?.[0].input.TransactItems as Array<{
      Update?: {
        TableName: string;
        Key: { id: string };
        ConditionExpression?: string;
        UpdateExpression?: string;
        ExpressionAttributeValues?: Record<string, unknown>;
      };
    }>;
    expect(writes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          Update: expect.objectContaining({
            TableName: "WorkspaceSlots",
            Key: { id: "slot" },
            ConditionExpression: "currentSessionId = :sid",
            UpdateExpression: expect.stringContaining("#s = :error"),
            ExpressionAttributeValues: expect.objectContaining({
              ":errorMessage": "cleanup failed",
            }),
          }),
        }),
        expect.objectContaining({
          Update: expect.objectContaining({
            TableName: "Sessions",
            Key: { id: "session" },
            ConditionExpression: expect.stringContaining("workspaceSlotId = :workspaceSlotId"),
            UpdateExpression: expect.stringContaining("workspaceSlotLease"),
            ExpressionAttributeValues: expect.objectContaining({ ":running": "running" }),
          }),
        }),
      ]),
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

  it("reserves the advertised host assignment cap in the claim transaction", async () => {
    const send = vi.fn().mockResolvedValue({});
    await expect(
      tryAssignSession(ctx(send), {
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
        hostAssignmentLease: { hostId: "host" },
        hostAssignmentCap: 1,
        legacyAssignmentCount: 1,
        queueShard: 0,
      }),
    ).resolves.toBe(true);
    const request = send.mock.calls[0]?.[0] as { input: { TransactItems: unknown[] } };
    expect(request.input.TransactItems).toContainEqual(
      expect.objectContaining({
        Update: expect.objectContaining({
          TableName: "HostLocks",
          ConditionExpression: expect.stringContaining("attribute_not_exists(assignmentCount)"),
          ExpressionAttributeValues: expect.objectContaining({ ":legacyCount": 1 }),
        }),
      }),
    );
  });

  it("counts an unbounded host assignment without a prior count", async () => {
    const send = vi.fn().mockResolvedValue({});
    await expect(
      tryAssignSession(ctx(send), {
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
        queueShard: 0,
      }),
    ).resolves.toBe(true);
    const request = send.mock.calls[0]?.[0] as { input: { TransactItems: unknown[] } };
    expect(request.input.TransactItems).toContainEqual(
      expect.objectContaining({
        Update: expect.objectContaining({
          TableName: "HostLocks",
          UpdateExpression: expect.stringContaining("assignmentCount"),
          ConditionExpression: expect.not.stringContaining(":cap"),
          ExpressionAttributeValues: expect.objectContaining({ ":legacyCount": 0 }),
        }),
      }),
    );
    expect(request.input.TransactItems).toContainEqual(
      expect.objectContaining({
        Update: expect.objectContaining({
          TableName: "Sessions",
          ExpressionAttributeValues: expect.objectContaining({
            ":hostAssignmentLease": { hostId: "host" },
          }),
        }),
      }),
    );
  });

  it("includes a host lease in main-checkout assignment expressions", async () => {
    const send = vi.fn().mockResolvedValue({});
    await expect(
      tryAssignMainCheckoutSession(ctx(send), {
        sessionId: "session",
        hostId: "host",
        hostInventoryVersion: null,
        repositoryId: "repo",
        connectionId: "connection",
        now: "now",
        resolvedArgv: ["echo"],
        resolvedRoute: {
          targetIndex: 0,
          commandId: "command",
          hostId: "host",
          worktreeId: null,
          attemptId: "attempt",
        },
        hostAssignmentLease: { hostId: "host" },
        hostAssignmentCap: 2,
        legacyAssignmentCount: 1,
        queueShard: 0,
        attemptId: "attempt",
      }),
    ).resolves.toBe(true);
    const request = send.mock.calls[0]?.[0] as { input: { TransactItems: unknown[] } };
    expect(request.input.TransactItems).toContainEqual(
      expect.objectContaining({
        Update: expect.objectContaining({
          TableName: "HostLocks",
          UpdateExpression: expect.stringContaining("assignmentCount"),
          ExpressionAttributeValues: expect.objectContaining({ ":legacyCount": 1, ":cap": 2 }),
        }),
      }),
    );
    expect(request.input.TransactItems).toContainEqual(
      expect.objectContaining({
        Update: expect.objectContaining({
          TableName: "Sessions",
          ExpressionAttributeValues: expect.objectContaining({
            ":hostAssignmentLease": { hostId: "host" },
          }),
        }),
      }),
    );
  });

  it("counts an unbounded main-checkout assignment", async () => {
    const send = vi.fn().mockResolvedValue({});
    await expect(
      tryAssignMainCheckoutSession(ctx(send), {
        sessionId: "session",
        hostId: "host",
        hostInventoryVersion: null,
        repositoryId: "repo",
        connectionId: "connection",
        now: "now",
        resolvedArgv: ["echo"],
        resolvedRoute: {
          targetIndex: 0,
          commandId: "command",
          hostId: "host",
          worktreeId: null,
          attemptId: "attempt",
        },
        queueShard: 0,
        attemptId: "attempt",
      }),
    ).resolves.toBe(true);
    const request = send.mock.calls[0]?.[0] as { input: { TransactItems: unknown[] } };
    expect(request.input.TransactItems).toContainEqual(
      expect.objectContaining({
        Update: expect.objectContaining({
          TableName: "HostLocks",
          UpdateExpression: expect.stringContaining("assignmentCount"),
          ConditionExpression: expect.not.stringContaining(":cap"),
          ExpressionAttributeValues: expect.objectContaining({ ":legacyCount": 0 }),
        }),
      }),
    );
    expect(request.input.TransactItems).toContainEqual(
      expect.objectContaining({
        Update: expect.objectContaining({
          TableName: "Sessions",
          ExpressionAttributeValues: expect.objectContaining({
            ":hostAssignmentLease": { hostId: "host" },
          }),
        }),
      }),
    );
  });

  it("releases a host lease while requeueing an assignment", async () => {
    const send = vi.fn().mockResolvedValue({});
    await expect(
      tryRequeueSession(ctx(send), {
        sessionId: "session",
        worktreeId: "worktree",
        attemptId: "attempt",
        queueShard: 0,
        hostAssignmentLease: { hostId: "host" },
      }),
    ).resolves.toBe(true);
    const request = send.mock.calls.at(-1)?.[0] as { input: { TransactItems: unknown[] } };
    expect(request.input.TransactItems).toContainEqual(
      expect.objectContaining({ Update: expect.objectContaining({ TableName: "HostLocks" }) }),
    );
  });

  it("deletes a concurrency lock while finishing a terminal assignment", async () => {
    const send = vi.fn().mockResolvedValue({});
    await expect(
      finishSession(ctx(send), {
        sessionId: "session",
        attemptId: "attempt",
        status: "completed",
        queueShard: 0,
        concurrencyId: "lock",
      }),
    ).resolves.toBe(true);
    const request = send.mock.calls.at(-1)?.[0] as { input: { TransactItems: unknown[] } };
    expect(request.input.TransactItems).toContainEqual(
      expect.objectContaining({
        Delete: expect.objectContaining({ Key: { concurrencyId: "lock" } }),
      }),
    );
  });

  it.each([
    [undefined, "idle", " REMOVE errorMessage", "running"],
    ["cleanup failed", "error", ", errorMessage = :errorMessage", "cancelled"],
  ])(
    "releases a workspace slot with error %s",
    async (workspaceSlotError, status, expression, expectedStatus) => {
      const send = vi.fn().mockResolvedValue({});
      await expect(
        finishSession(ctx(send), {
          sessionId: "session",
          workspaceSlotId: "slot",
          workspaceSlotError,
          attemptId: "attempt",
          status: "completed",
          expectedStatus,
          queueShard: 0,
        }),
      ).resolves.toBe(true);
      const request = send.mock.calls.at(-1)?.[0] as { input: { TransactItems: unknown[] } };
      expect(request.input.TransactItems).toContainEqual(
        expect.objectContaining({
          Update: expect.objectContaining({
            TableName: "WorkspaceSlots",
            UpdateExpression: expect.stringContaining(expression),
            ExpressionAttributeValues: expect.objectContaining({ ":status": status }),
          }),
        }),
      );
      expect(request.input.TransactItems[0]).toEqual(
        expect.objectContaining({
          Update: expect.objectContaining({
            ExpressionAttributeValues: expect.objectContaining({
              ":expectedStatus": expectedStatus,
            }),
          }),
        }),
      );
    },
  );
});
