import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";

import { isConditionalTransactionFailed, type PlaneStorageCtx } from "./plane-storage-types.ts";
import {
  readSessionDrainActivity,
  sessionDrainActivityDelete,
} from "./plane-storage-session-drain-activity.ts";
import { getSession } from "./plane-storage-sessions-query.ts";
import {
  providerAccountLeaseDeleteItems,
  type ProviderAccountLeaseKey,
} from "./plane-storage-provider-account-leases.ts";

type ReleaseCancelledOpts = {
  sessionId: string;
  worktreeId: string;
  /** A late terminal report from a healthy socket frees the worktree for
   * another assignment; only disconnect cleanup offlines it. */
  online: boolean;
  cliResumeRef?: string | undefined;
  fence?: { hostId: string; connectionId: string } | undefined;
  attemptId: string;
  concurrencyId?: string | undefined;
  providerAccountLease?: ProviderAccountLeaseKey | undefined;
};

function releaseFenceCheck(ctx: PlaneStorageCtx, fence?: { hostId: string; connectionId: string }) {
  if (!fence) return [];
  return [
    {
      ConditionCheck: {
        TableName: ctx.tables.hostLocks,
        Key: { hostId: fence.hostId },
        ConditionExpression: "connectionId = :connectionId",
        ExpressionAttributeValues: { ":connectionId": fence.connectionId },
      },
    },
  ];
}

function releaseSessionUpdate(
  ctx: PlaneStorageCtx,
  opts: ReleaseCancelledOpts,
  requireNoDrainCancellation: boolean,
) {
  return {
    Update: {
      TableName: ctx.tables.sessions,
      Key: { id: opts.sessionId },
      UpdateExpression:
        `SET worktreeId = :null${opts.cliResumeRef ? ", cliResumeRef = :cliResumeRef" : ""} ` +
        "REMOVE assignmentConnectionId, reconnectDeadlineAt, providerAccountLease",
      ConditionExpression:
        "#s = :cancelled AND worktreeId = :worktreeId AND attemptId = :attemptId" +
        (requireNoDrainCancellation
          ? " AND attribute_not_exists(cancelledByDrainOperationId)"
          : ""),
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":cancelled": "cancelled",
        ":null": null,
        ":worktreeId": opts.worktreeId,
        ...(opts.cliResumeRef ? { ":cliResumeRef": opts.cliResumeRef } : {}),
        ":attemptId": opts.attemptId,
      },
    },
  };
}

function releaseWorktreeUpdate(ctx: PlaneStorageCtx, opts: ReleaseCancelledOpts) {
  return {
    Update: {
      TableName: ctx.tables.worktrees,
      Key: { id: opts.worktreeId },
      UpdateExpression: "SET #s = :idle, currentSessionId = :null, #o = :online",
      ConditionExpression:
        "currentSessionId = :sid" +
        (opts.fence
          ? " AND (attribute_not_exists(connectionId) OR connectionId = :connectionId)"
          : ""),
      ExpressionAttributeNames: { "#s": "status", "#o": "online" },
      ExpressionAttributeValues: {
        ":idle": "idle",
        ":null": null,
        ":sid": opts.sessionId,
        ":online": opts.online,
        ...(opts.fence ? { ":connectionId": opts.fence.connectionId } : {}),
      },
    },
  };
}

function releaseConcurrencyDelete(ctx: PlaneStorageCtx, opts: ReleaseCancelledOpts) {
  if (!opts.concurrencyId) return [];
  return [
    {
      Delete: {
        TableName: ctx.tables.concurrencyLocks,
        Key: { concurrencyId: opts.concurrencyId },
        ConditionExpression: "attribute_not_exists(concurrencyId) OR sessionId = :sessionId",
        ExpressionAttributeValues: { ":sessionId": opts.sessionId },
      },
    },
  ];
}

async function releaseCancelledConflict(
  ctx: PlaneStorageCtx,
  opts: ReleaseCancelledOpts,
  requireNoDrainCancellation: boolean,
): Promise<boolean> {
  // The only new value that can make the cleanup fence fail is a drain
  // cancellation written after `before`. Re-read it and retry without the
  // ACT delete, so the late terminal still frees the worktree.
  if (requireNoDrainCancellation) {
    const current = await readSessionDrainActivity(ctx, opts.sessionId);
    if (current?.session.cancelledByDrainOperationId) {
      return releaseCancelledSessionWorktree(ctx, opts);
    }
  }
  const current = await getSession(ctx, opts.sessionId);
  return current?.status === "cancelled" && current.worktreeId == null;
}

/**
 * A running session cancelled by an operator deliberately keeps its worktree
 * busy until the agent reports a terminal status. Release that exact claim
 * without changing the cancelled status, and detach the terminal session so a
 * duplicate late report is an idempotent no-op.
 */
export async function releaseCancelledSessionWorktree(
  ctx: PlaneStorageCtx,
  opts: ReleaseCancelledOpts,
): Promise<boolean> {
  const before = await readSessionDrainActivity(ctx, opts.sessionId);
  // A drain-owned cancellation remains in the ledger until its operation has
  // reconciled it. Ordinary cancellations are terminal activity and can go.
  const cleanup = before?.session.cancelledByDrainOperationId
    ? []
    : sessionDrainActivityDelete(ctx, before?.activity ?? null);
  // If a drain cancellation won after the strong pre-read, do not let this
  // terminal release delete the member its drain still needs to reconcile.
  // The caller will retry from the newly durable cancellation state.
  const requireNoDrainCancellation = cleanup.length > 0;
  try {
    await ctx.doc.send(
      new TransactWriteCommand({
        TransactItems: [
          ...releaseFenceCheck(ctx, opts.fence),
          releaseSessionUpdate(ctx, opts, requireNoDrainCancellation),
          releaseWorktreeUpdate(ctx, opts),
          ...releaseConcurrencyDelete(ctx, opts),
          ...providerAccountLeaseDeleteItems(
            ctx.tables.concurrencyLocks,
            opts.sessionId,
            opts.providerAccountLease,
          ),
          ...cleanup,
        ],
      }),
    );
    return true;
  } catch (err) {
    if (isConditionalTransactionFailed(err)) {
      return releaseCancelledConflict(ctx, opts, requireNoDrainCancellation);
    }
    throw err;
  }
}
