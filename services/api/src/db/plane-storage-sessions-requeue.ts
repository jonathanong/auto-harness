import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";

import { statusShardAttr } from "./dynamo.ts";
import { isConditionalTransactionFailed, type PlaneStorageCtx } from "./plane-storage-types.ts";
import { queueOrderForSession } from "./plane-storage-sessions-queue.ts";
import {
  providerAccountLeaseDeleteItems,
  type ProviderAccountLeaseKey,
} from "./plane-storage-provider-account-leases.ts";
import {
  hostAssignmentReleaseItem,
  type HostAssignmentLease,
} from "./plane-storage-host-assignment.ts";

type RequeueOpts = {
  sessionId: string;
  worktreeId: string;
  attemptId: string;
  queueShard: number;
  reason?: string;
  forceOffline?: boolean;
  expectedHostId?: string;
  expectedReconnectDeadlineAt?: string;
  expectedConnectionId?: string;
  nextConnectionId?: string;
  requireNoHostLock?: string;
  fence?: { hostId: string; connectionId: string };
  requireUnacknowledged?: boolean;
  providerAccountLease?: ProviderAccountLeaseKey | undefined;
  hostAssignmentLease?: HostAssignmentLease | undefined;
  /** Bounded safe-replay marker for an infrastructure failure. */
  infrastructureErrorCode?: "checkout_fetch_failed" | "host_lost";
};

function hostLockChecks(ctx: PlaneStorageCtx, opts: RequeueOpts): Array<Record<string, unknown>> {
  const items: Array<Record<string, unknown>> = [];
  if (opts.fence && !opts.hostAssignmentLease) {
    items.push({
      ConditionCheck: {
        TableName: ctx.tables.hostLocks,
        Key: { hostId: opts.fence.hostId },
        ConditionExpression: "connectionId = :connectionId",
        ExpressionAttributeValues: { ":connectionId": opts.fence.connectionId },
      },
    });
  }
  if (opts.requireNoHostLock) {
    items.push({
      ConditionCheck: {
        TableName: ctx.tables.hostLocks,
        Key: { hostId: opts.requireNoHostLock },
        // A disconnect retains its row for alerts and reconnect bookkeeping.
        // Treat that retained row as absent, but let a concurrent replacement
        // registration make this transition lose its fence.
        ConditionExpression: "attribute_not_exists(hostId) OR disconnected = :true",
        ExpressionAttributeValues: { ":true": true },
      },
    });
  }
  return items;
}

function requeueWorktreeUpdate(ctx: PlaneStorageCtx, opts: RequeueOpts) {
  return {
    Update: {
      TableName: ctx.tables.worktrees,
      Key: { id: opts.worktreeId },
      UpdateExpression:
        "SET #s = :idle, currentSessionId = :null, #o = :online" +
        (opts.nextConnectionId ? ", connectionId = :nextConnectionId" : ""),
      ConditionExpression:
        "currentSessionId = :sid" +
        (opts.expectedConnectionId
          ? " AND (attribute_not_exists(connectionId) OR connectionId = :connectionId)"
          : ""),
      ExpressionAttributeNames: { "#s": "status", "#o": "online" },
      ExpressionAttributeValues: {
        ":idle": "idle",
        ":null": null,
        ":online": opts.forceOffline !== true,
        ":sid": opts.sessionId,
        ...(opts.expectedConnectionId ? { ":connectionId": opts.expectedConnectionId } : {}),
        ...(opts.nextConnectionId ? { ":nextConnectionId": opts.nextConnectionId } : {}),
      },
    },
  };
}

function requeueSessionCondition(opts: RequeueOpts): string {
  let condition = "#s = :running AND worktreeId = :worktreeId AND attemptId = :attemptId";
  if (opts.requireUnacknowledged) condition += " AND attribute_not_exists(ackReceivedAt)";
  if (opts.expectedHostId) condition += " AND hostId = :hostId";
  if (opts.expectedReconnectDeadlineAt) {
    condition += " AND reconnectDeadlineAt = :reconnectDeadlineAt";
  }
  if (opts.expectedConnectionId) {
    condition +=
      " AND (attribute_not_exists(assignmentConnectionId) OR assignmentConnectionId = :connectionId)";
  }
  if (opts.infrastructureErrorCode) {
    condition +=
      " AND (attribute_not_exists(infrastructureRetryCount) OR infrastructureRetryCount < :maxInfrastructureRetries)";
  }
  if (opts.infrastructureErrorCode === "host_lost") {
    condition += " AND primaryCommandStartState = :pendingCommandStart";
  }
  return condition;
}

function requeueSessionUpdate(ctx: PlaneStorageCtx, opts: RequeueOpts, queueOrder: unknown) {
  return {
    Update: {
      TableName: ctx.tables.sessions,
      Key: { id: opts.sessionId },
      UpdateExpression:
        "SET #s = :queued, statusShard = :statusShard, queueOrder = :queueOrder" +
        ", worktreeId = :null, hostId = :null, errorMessage = :reason" +
        (opts.infrastructureErrorCode
          ? ", infrastructureRetryCount = if_not_exists(infrastructureRetryCount, :zero) + :one, lastInfrastructureErrorCode = :infrastructureErrorCode"
          : "") +
        " REMOVE startedAt, ackReceivedAt, reconnectDeadlineAt, assignmentConnectionId, activeHostId, activeHostOrder, providerAccountLease, hostAssignmentLease, primaryCommandStartState",
      ConditionExpression: requeueSessionCondition(opts),
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":queued": "queued",
        ":running": "running",
        ":statusShard": statusShardAttr("queued", opts.queueShard),
        ":queueOrder": queueOrder,
        ":null": null,
        ":reason": opts.reason ?? "agent disconnected; requeued",
        ...(opts.expectedHostId ? { ":hostId": opts.expectedHostId } : {}),
        ...(opts.expectedReconnectDeadlineAt
          ? { ":reconnectDeadlineAt": opts.expectedReconnectDeadlineAt }
          : {}),
        ...(opts.expectedConnectionId ? { ":connectionId": opts.expectedConnectionId } : {}),
        ":worktreeId": opts.worktreeId,
        ":attemptId": opts.attemptId,
        ...(opts.infrastructureErrorCode
          ? {
              ":zero": 0,
              ":one": 1,
              ":maxInfrastructureRetries": 1,
              ":infrastructureErrorCode": opts.infrastructureErrorCode,
            }
          : {}),
        ...(opts.infrastructureErrorCode === "host_lost"
          ? { ":pendingCommandStart": "pending" }
          : {}),
      },
    },
  };
}

/** Atomically release a worktree and requeue its running session. */
export async function tryRequeueSession(ctx: PlaneStorageCtx, opts: RequeueOpts): Promise<boolean> {
  const queueOrder = await queueOrderForSession(ctx, opts.sessionId);
  try {
    await ctx.doc.send(
      new TransactWriteCommand({
        TransactItems: [
          ...hostLockChecks(ctx, opts),
          requeueWorktreeUpdate(ctx, opts),
          requeueSessionUpdate(ctx, opts, queueOrder),
          ...providerAccountLeaseDeleteItems(
            ctx.tables.concurrencyLocks,
            opts.sessionId,
            opts.providerAccountLease,
          ),
          ...(opts.hostAssignmentLease
            ? [hostAssignmentReleaseItem(ctx, opts.hostAssignmentLease)]
            : []),
        ],
      }),
    );
    return true;
  } catch (err) {
    if (isConditionalTransactionFailed(err)) {
      return false;
    }
    throw err;
  }
}
