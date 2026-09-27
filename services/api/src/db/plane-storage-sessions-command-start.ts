import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";

import { isConditionalTransactionFailed, type PlaneStorageCtx } from "./plane-storage-types.ts";

type CommandStart = {
  sessionId: string;
  worktreeId: string | null;
  attemptId: string;
  fence?: { hostId: string; connectionId: string };
};

/**
 * Durably authorize the primary command immediately before it starts. The
 * assignment and connection fences make duplicated/replayed v4 frames safe.
 */
export async function authorizePrimaryCommandStart(
  ctx: PlaneStorageCtx,
  opts: CommandStart,
): Promise<boolean> {
  const update = {
    Update: {
      TableName: ctx.tables.sessions,
      Key: { id: opts.sessionId },
      UpdateExpression:
        "SET primaryCommandStartState = :authorized, reportingAdmissionAttemptId = :attemptId REMOVE reportingAdmissionBlocked",
      ConditionExpression:
        "#s = :running AND worktreeId = :worktreeId AND attemptId = :attemptId" +
        " AND (primaryCommandStartState = :pending OR (primaryCommandStartState = :authorized AND reportingAdmissionAttemptId = :attemptId))" +
        (opts.fence ? " AND hostId = :hostId AND assignmentConnectionId = :connectionId" : ""),
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":authorized": "authorized",
        ":pending": "pending",
        ":running": "running",
        ":worktreeId": opts.worktreeId,
        ":attemptId": opts.attemptId,
        ...(opts.fence
          ? { ":hostId": opts.fence.hostId, ":connectionId": opts.fence.connectionId }
          : {}),
      },
    },
  };
  try {
    if (opts.fence) {
      await ctx.doc.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              ConditionCheck: {
                TableName: ctx.tables.hostLocks,
                Key: { hostId: opts.fence.hostId },
                ConditionExpression:
                  "connectionId = :connectionId AND (attribute_not_exists(disconnected) OR disconnected = :false)",
                ExpressionAttributeValues: {
                  ":connectionId": opts.fence.connectionId,
                  ":false": false,
                },
              },
            },
            update,
          ],
        }),
      );
    } else {
      await ctx.doc.send(new TransactWriteCommand({ TransactItems: [update] }));
    }
    return true;
  } catch (err) {
    if (!isConditionalTransactionFailed(err)) throw err;
    return false;
  }
}
