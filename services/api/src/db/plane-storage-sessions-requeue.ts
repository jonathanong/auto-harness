import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";

import { statusShardAttr } from "./dynamo.ts";
import { isConditionalTransactionFailed, type PlaneStorageCtx } from "./plane-storage-types.ts";
import { queueOrderForSession } from "./plane-storage-sessions-queue.ts";

/** Atomically release a worktree and requeue its running session. */
export async function tryRequeueSession(
  ctx: PlaneStorageCtx,
  opts: {
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
  },
): Promise<boolean> {
  const queueOrder = await queueOrderForSession(ctx, opts.sessionId);
  try {
    await ctx.doc.send(
      new TransactWriteCommand({
        TransactItems: [
          ...(opts.fence
            ? [
                {
                  ConditionCheck: {
                    TableName: ctx.tables.hostLocks,
                    Key: { hostId: opts.fence.hostId },
                    ConditionExpression: "connectionId = :connectionId",
                    ExpressionAttributeValues: { ":connectionId": opts.fence.connectionId },
                  },
                },
              ]
            : []),
          ...(opts.requireNoHostLock
            ? [
                {
                  ConditionCheck: {
                    TableName: ctx.tables.hostLocks,
                    Key: { hostId: opts.requireNoHostLock },
                    ConditionExpression: "attribute_not_exists(hostId)",
                  },
                },
              ]
            : []),
          {
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
                ...(opts.expectedConnectionId
                  ? { ":connectionId": opts.expectedConnectionId }
                  : {}),
                ...(opts.nextConnectionId ? { ":nextConnectionId": opts.nextConnectionId } : {}),
              },
            },
          },
          {
            Update: {
              TableName: ctx.tables.sessions,
              Key: { id: opts.sessionId },
              UpdateExpression:
                "SET #s = :queued, statusShard = :statusShard, queueOrder = :queueOrder" +
                ", worktreeId = :null, hostId = :null, errorMessage = :reason REMOVE startedAt, ackReceivedAt, reconnectDeadlineAt, assignmentConnectionId",
              ConditionExpression:
                "#s = :running AND worktreeId = :worktreeId AND attemptId = :attemptId" +
                (opts.requireUnacknowledged ? " AND attribute_not_exists(ackReceivedAt)" : "") +
                (opts.expectedHostId ? " AND hostId = :hostId" : "") +
                (opts.expectedReconnectDeadlineAt
                  ? " AND reconnectDeadlineAt = :reconnectDeadlineAt"
                  : "") +
                (opts.expectedConnectionId
                  ? " AND (attribute_not_exists(assignmentConnectionId) OR assignmentConnectionId = :connectionId)"
                  : ""),
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
                ...(opts.expectedConnectionId
                  ? { ":connectionId": opts.expectedConnectionId }
                  : {}),
                ":worktreeId": opts.worktreeId,
                ":attemptId": opts.attemptId,
              },
            },
          },
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
