import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";

import { isConditionalTransactionFailed, type PlaneStorageCtx } from "./plane-storage-types.ts";

export async function markMainCheckoutReconnectPending(
  ctx: PlaneStorageCtx,
  opts: {
    sessionId: string;
    hostId: string;
    repositoryId: string;
    connectionId: string;
    deadlineAt: string;
  },
): Promise<boolean> {
  try {
    await ctx.doc.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            ConditionCheck: {
              TableName: ctx.tables.hostLocks,
              Key: { hostId: opts.hostId },
              ConditionExpression:
                "mainCheckoutLeases.#repo.sessionId = :sessionId AND mainCheckoutLeases.#repo.connectionId = :connectionId",
              ExpressionAttributeNames: { "#repo": opts.repositoryId },
              ExpressionAttributeValues: {
                ":sessionId": opts.sessionId,
                ":connectionId": opts.connectionId,
              },
            },
          },
          {
            Update: {
              TableName: ctx.tables.sessions,
              Key: { id: opts.sessionId },
              UpdateExpression: "SET reconnectDeadlineAt = :deadlineAt",
              ConditionExpression:
                "#s = :running AND hostId = :hostId AND assignmentConnectionId = :connectionId AND mainCheckoutLease = :true AND attribute_not_exists(reconnectDeadlineAt)",
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: {
                ":running": "running",
                ":hostId": opts.hostId,
                ":connectionId": opts.connectionId,
                ":true": true,
                ":deadlineAt": opts.deadlineAt,
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

export async function confirmMainCheckoutReconnect(
  ctx: PlaneStorageCtx,
  opts: {
    sessionId: string;
    hostId: string;
    repositoryId: string;
    oldConnectionId: string;
    connectionId: string;
    deadlineAt?: string;
  },
): Promise<boolean> {
  try {
    await ctx.doc.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: ctx.tables.hostLocks,
              Key: { hostId: opts.hostId },
              UpdateExpression: "SET mainCheckoutLeases.#repo.connectionId = :newConnectionId",
              ConditionExpression:
                "connectionId = :newConnectionId AND mainCheckoutLeases.#repo.sessionId = :sessionId AND mainCheckoutLeases.#repo.connectionId = :oldConnectionId",
              ExpressionAttributeNames: { "#repo": opts.repositoryId },
              ExpressionAttributeValues: {
                ":newConnectionId": opts.connectionId,
                ":oldConnectionId": opts.oldConnectionId,
                ":sessionId": opts.sessionId,
              },
            },
          },
          {
            Update: {
              TableName: ctx.tables.sessions,
              Key: { id: opts.sessionId },
              UpdateExpression:
                "SET assignmentConnectionId = :newConnectionId REMOVE reconnectDeadlineAt",
              ConditionExpression:
                "#s = :running AND hostId = :hostId AND assignmentConnectionId = :oldConnectionId AND mainCheckoutLease = :true AND attribute_exists(ackReceivedAt)" +
                (opts.deadlineAt ? " AND reconnectDeadlineAt = :deadlineAt" : ""),
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: {
                ":running": "running",
                ":hostId": opts.hostId,
                ":oldConnectionId": opts.oldConnectionId,
                ":newConnectionId": opts.connectionId,
                ":true": true,
                ...(opts.deadlineAt ? { ":deadlineAt": opts.deadlineAt } : {}),
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
