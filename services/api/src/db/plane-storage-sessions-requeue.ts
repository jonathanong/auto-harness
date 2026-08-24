import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";

import { statusShardAttr } from "./dynamo.ts";
import { isConditionalTransactionFailed, type PlaneStorageCtx } from "./plane-storage-types.ts";
import { queueOrderForSession } from "./plane-storage-sessions-queue.ts";

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
};

function hostLockChecks(ctx: PlaneStorageCtx, opts: RequeueOpts): Array<Record<string, unknown>> {
  const items: Array<Record<string, unknown>> = [];
  if (opts.fence) {
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
        ConditionExpression: "attribute_not_exists(hostId)",
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
  return condition;
}

function requeueSessionUpdate(ctx: PlaneStorageCtx, opts: RequeueOpts, queueOrder: unknown) {
  return {
    Update: {
      TableName: ctx.tables.sessions,
      Key: { id: opts.sessionId },
      UpdateExpression:
        "SET #s = :queued, statusShard = :statusShard, queueOrder = :queueOrder" +
        ", worktreeId = :null, hostId = :null, errorMessage = :reason REMOVE startedAt, ackReceivedAt, reconnectDeadlineAt, assignmentConnectionId, providerAccountLease",
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
