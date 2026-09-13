import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";

import { getSession } from "./plane-storage-sessions-query.ts";
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
      UpdateExpression: "SET primaryCommandStartState = :authorized",
      ConditionExpression:
        "#s = :running AND worktreeId = :worktreeId AND attemptId = :attemptId" +
        " AND primaryCommandStartState = :pending",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":authorized": "authorized",
        ":pending": "pending",
        ":running": "running",
        ":worktreeId": opts.worktreeId,
        ":attemptId": opts.attemptId,
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
                ConditionExpression: "connectionId = :connectionId",
                ExpressionAttributeValues: { ":connectionId": opts.fence.connectionId },
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
    if (
      opts.fence &&
      !(await hostLockMatchesFence(ctx, opts.fence.hostId, opts.fence.connectionId))
    ) {
      return false;
    }
    const current = await getSession(ctx, opts.sessionId, true);
    return Boolean(
      current?.status === "running" &&
      current.worktreeId === opts.worktreeId &&
      current.attemptId === opts.attemptId &&
      current.primaryCommandStartState === "authorized" &&
      (!opts.fence ||
        (current.hostId === opts.fence.hostId &&
          (current.assignmentConnectionId === undefined ||
            current.assignmentConnectionId === opts.fence.connectionId))),
    );
  }
}

/** The replay path must verify that this connection still owns the host. */
async function hostLockMatchesFence(
  ctx: PlaneStorageCtx,
  hostId: string,
  connectionId: string,
): Promise<boolean> {
  const lock = await ctx.doc.send(
    new GetCommand({
      TableName: ctx.tables.hostLocks,
      Key: { hostId },
      ConsistentRead: true,
    }),
  );
  return lock.Item?.connectionId === connectionId && lock.Item.disconnected !== true;
}
