import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";

import type { PlaneStorageCtx } from "./plane-storage-types.ts";
import { isConditionalTransactionFailed } from "./plane-storage-types.ts";

type ReconnectSession = {
  sessionId: string;
  hostId: string;
  worktreeId: string;
  deadlineAt?: string;
  connectionId: string;
};

/** Atomically take an acknowledged session offline without allowing a late
 * terminal transition to be overwritten by a stale disconnect callback. */
export async function markReconnectPending(
  ctx: PlaneStorageCtx,
  opts: ReconnectSession,
): Promise<boolean> {
  try {
    await ctx.doc.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            ConditionCheck: {
              TableName: ctx.tables.hostLocks,
              Key: { hostId: opts.hostId },
              ConditionExpression: "connectionId = :connectionId",
              ExpressionAttributeValues: { ":connectionId": opts.connectionId },
            },
          },
          {
            Update: {
              TableName: ctx.tables.sessions,
              Key: { id: opts.sessionId },
              UpdateExpression:
                "SET reconnectDeadlineAt = :deadline, assignmentConnectionId = :connectionId",
              ConditionExpression:
                "#s = :running AND hostId = :hostId AND worktreeId = :worktreeId AND (attribute_not_exists(assignmentConnectionId) OR assignmentConnectionId = :connectionId) AND attribute_exists(ackReceivedAt) AND attribute_not_exists(reconnectDeadlineAt)",
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: {
                ":deadline": opts.deadlineAt,
                ":running": "running",
                ":hostId": opts.hostId,
                ":worktreeId": opts.worktreeId,
                ":connectionId": opts.connectionId,
              },
            },
          },
          {
            Update: {
              TableName: ctx.tables.worktrees,
              Key: { id: opts.worktreeId },
              UpdateExpression: "SET #o = :offline, connectionId = :connectionId",
              ConditionExpression:
                "currentSessionId = :sessionId AND (attribute_not_exists(connectionId) OR connectionId = :connectionId)",
              ExpressionAttributeNames: { "#o": "online" },
              ExpressionAttributeValues: {
                ":offline": false,
                ":sessionId": opts.sessionId,
                ":connectionId": opts.connectionId,
              },
            },
          },
        ],
      }),
    );
    return true;
  } catch (err) {
    if (isConditionalTransactionFailed(err)) return false;
    throw err;
  }
}

/** A reconnect may clear only the deadline it observed, preserving terminal
 * writes and an expiry sweep that won first. */
export async function confirmReconnect(
  ctx: PlaneStorageCtx,
  opts: ReconnectSession,
): Promise<boolean> {
  try {
    await ctx.doc.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            ConditionCheck: {
              TableName: ctx.tables.hostLocks,
              Key: { hostId: opts.hostId },
              ConditionExpression: "connectionId = :connectionId",
              ExpressionAttributeValues: { ":connectionId": opts.connectionId },
            },
          },
          {
            Update: {
              TableName: ctx.tables.sessions,
              Key: { id: opts.sessionId },
              UpdateExpression:
                "SET assignmentConnectionId = :connectionId REMOVE reconnectDeadlineAt",
              ConditionExpression:
                "#s = :running AND hostId = :hostId AND worktreeId = :worktreeId" +
                (opts.deadlineAt
                  ? " AND reconnectDeadlineAt = :deadline"
                  : " AND attribute_not_exists(reconnectDeadlineAt)"),
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: {
                ":running": "running",
                ":hostId": opts.hostId,
                ":worktreeId": opts.worktreeId,
                ...(opts.deadlineAt ? { ":deadline": opts.deadlineAt } : {}),
                ":connectionId": opts.connectionId,
              },
            },
          },
          {
            Update: {
              TableName: ctx.tables.worktrees,
              Key: { id: opts.worktreeId },
              UpdateExpression: "SET #o = :online, connectionId = :connectionId",
              ConditionExpression: "currentSessionId = :sessionId",
              ExpressionAttributeNames: { "#o": "online" },
              ExpressionAttributeValues: {
                ":online": true,
                ":sessionId": opts.sessionId,
                ":connectionId": opts.connectionId,
              },
            },
          },
        ],
      }),
    );
    return true;
  } catch (err) {
    if (isConditionalTransactionFailed(err)) return false;
    throw err;
  }
}
