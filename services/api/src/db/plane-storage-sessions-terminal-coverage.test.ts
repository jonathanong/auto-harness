import { describe, expect, it, vi } from "vitest";

import { finishSession } from "./plane-storage-sessions-terminal.ts";
import type { PlaneStorageCtx } from "./plane-storage-types.ts";

function ctx(send: ReturnType<typeof vi.fn>): PlaneStorageCtx {
  return {
    doc: { send } as never,
    tables: {
      sessions: "Sessions",
      worktrees: "Worktrees",
      concurrencyLocks: "Locks",
      hostLocks: "HostLocks",
      sessionDrains: "SessionDrains",
    } as never,
  } as PlaneStorageCtx;
}

const item = {
  id: "session",
  status: "running",
  createdAt: "now",
  priority: 0,
  cancelledByDrainOperationId: "drain",
};

describe("session terminal cleanup branches", () => {
  it("skips drain cleanup once a drain already cancelled the session", async () => {
    const send = vi.fn().mockResolvedValueOnce({ Item: item }).mockResolvedValueOnce({});
    await expect(
      finishSession(ctx(send), {
        sessionId: "session",
        attemptId: "attempt",
        status: "failed",
        queueShard: 0,
      }),
    ).resolves.toBe(true);
  });

  it("keeps assignment leases on timeout and rethrows non-conditional failures", async () => {
    const send = vi.fn().mockResolvedValue({});
    await expect(
      finishSession(ctx(send), {
        sessionId: "session",
        attemptId: "attempt",
        status: "failed",
        queueShard: 0,
        preserveHostAssignmentLease: true,
        preserveProviderAccountLease: true,
        hostAssignmentLease: { hostId: "host" },
        providerAccountLease: {
          concurrencyId: "acct:0",
          attemptId: "attempt",
          providerAccountId: "acct",
          slot: 0,
        },
      }),
    ).resolves.toBe(true);
    const failure = new Error("finish unavailable");
    const boom = vi.fn().mockResolvedValueOnce({}).mockRejectedValueOnce(failure);
    await expect(
      finishSession(ctx(boom), {
        sessionId: "session",
        attemptId: "attempt",
        status: "failed",
        queueShard: 0,
      }),
    ).rejects.toBe(failure);
  });

  it("preserves workspace and provider leases for a timeout terminal write", async () => {
    const send = vi.fn().mockResolvedValue({});
    await expect(
      finishSession(ctx(send), {
        sessionId: "workspace",
        worktreeId: null,
        workspaceSlotId: "slot",
        attemptId: "attempt",
        status: "timed_out",
        queueShard: 0,
        preserveWorkspaceSlotLease: true,
        preserveReconnectDeadlineAt: true,
        preserveProviderAccountLease: true,
        preserveHostAssignmentLease: true,
        providerAccountLease: {
          concurrencyId: "account-lock",
          attemptId: "attempt",
          providerAccountId: "account",
          slot: 0,
        },
        hostAssignmentLease: { hostId: "host", connectionId: "connection" },
      }),
    ).resolves.toBe(true);
    const items = send.mock.calls[send.mock.calls.length - 1]?.[0].input.TransactItems as Array<{
      Update?: { TableName?: string; UpdateExpression?: string };
    }>;
    expect(items).toHaveLength(2);
    expect(
      items.find((transactionItem) => transactionItem.Update?.TableName === "Sessions")?.Update
        ?.UpdateExpression,
    ).not.toContain("workspaceSlotId = :null");
    expect(
      items.find((transactionItem) => transactionItem.Update?.TableName === "Sessions")?.Update
        ?.UpdateExpression,
    ).not.toContain("reconnectDeadlineAt");
  });
});
