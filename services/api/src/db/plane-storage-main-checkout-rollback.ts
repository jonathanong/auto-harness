import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";

import { isConditionalTransactionFailed, type PlaneStorageCtx } from "./plane-storage-types.ts";

export async function restoreMainCheckoutReconnect(
  ctx: PlaneStorageCtx,
  opts: {
    sessionId: string;
    hostId: string;
    repositoryId: string;
    connectionId: string;
    previousConnectionId: string;
    previousDeadlineAt?: string;
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
              UpdateExpression: "SET mainCheckoutLeases.#repo.connectionId = :previousConnectionId",
              ConditionExpression:
                "connectionId = :connectionId AND mainCheckoutLeases.#repo.sessionId = :sessionId AND mainCheckoutLeases.#repo.connectionId = :connectionId",
              ExpressionAttributeNames: { "#repo": opts.repositoryId },
              ExpressionAttributeValues: {
                ":connectionId": opts.connectionId,
                ":sessionId": opts.sessionId,
                ":previousConnectionId": opts.previousConnectionId,
              },
            },
          },
          {
            Update: {
              TableName: ctx.tables.sessions,
              Key: { id: opts.sessionId },
              UpdateExpression:
                "SET assignmentConnectionId = :previousConnectionId" +
                (opts.previousDeadlineAt
                  ? ", reconnectDeadlineAt = :deadlineAt"
                  : " REMOVE reconnectDeadlineAt"),
              ConditionExpression:
                "#s = :running AND hostId = :hostId AND assignmentConnectionId = :connectionId AND mainCheckoutLease = :true",
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: {
                ":running": "running",
                ":hostId": opts.hostId,
                ":connectionId": opts.connectionId,
                ":previousConnectionId": opts.previousConnectionId,
                ":true": true,
                ...(opts.previousDeadlineAt ? { ":deadlineAt": opts.previousDeadlineAt } : {}),
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
