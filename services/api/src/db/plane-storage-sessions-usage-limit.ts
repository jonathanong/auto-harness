import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";

import { statusShardAttr } from "./dynamo.ts";
import { isConditionalTransactionFailed, type PlaneStorageCtx } from "./plane-storage-types.ts";
import { queueOrderForSession } from "./plane-storage-sessions-queue.ts";

/** Atomically pause the assigned global account, free the worktree, and requeue the session. */
export async function requeueUsageLimitedSession(
  ctx: PlaneStorageCtx,
  opts: {
    sessionId: string;
    worktreeId: string;
    attemptId: string;
    providerAccountId: string;
    queueShard: number;
    now: string;
    usageLimitedUntil: string;
    errorMessage?: string;
  },
): Promise<boolean> {
  const queueOrder = await queueOrderForSession(ctx, opts.sessionId);
  try {
    await ctx.doc.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: ctx.tables.providerAccounts,
              Key: { id: opts.providerAccountId },
              UpdateExpression:
                "SET usageLimitedUntil = :until, lastUsageLimitedAt = :now, updatedAt = :now",
              ConditionExpression: "attribute_exists(id)",
              ExpressionAttributeValues: { ":until": opts.usageLimitedUntil, ":now": opts.now },
            },
          },
          {
            Update: {
              TableName: ctx.tables.worktrees,
              Key: { id: opts.worktreeId },
              UpdateExpression: "SET #s = :idle, currentSessionId = :null",
              ConditionExpression: "currentSessionId = :sid",
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: { ":idle": "idle", ":null": null, ":sid": opts.sessionId },
            },
          },
          {
            Update: {
              TableName: ctx.tables.sessions,
              Key: { id: opts.sessionId },
              UpdateExpression:
                "SET #s = :queued, statusShard = :statusShard, queueOrder = :queueOrder" +
                ", worktreeId = :null, hostId = :null, errorCode = :code, errorMessage = :message REMOVE startedAt, ackReceivedAt",
              ConditionExpression:
                "#s = :running AND worktreeId = :worktreeId AND attemptId = :attemptId",
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: {
                ":queued": "queued",
                ":running": "running",
                ":statusShard": statusShardAttr("queued", opts.queueShard),
                ":queueOrder": queueOrder,
                ":null": null,
                ":code": "usage_limit",
                ":message": opts.errorMessage ?? "provider usage limit; requeued",
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
    if (isConditionalTransactionFailed(err)) return false;
    throw err;
  }
}

/** Requeue a providerless command and remember that this target is exhausted for this session. */
export async function suppressProviderlessUsageLimit(
  ctx: PlaneStorageCtx,
  opts: {
    sessionId: string;
    worktreeId: string;
    attemptId: string;
    queueShard: number;
    targetIndex: number;
    errorMessage?: string;
  },
): Promise<boolean> {
  const queueOrder = await queueOrderForSession(ctx, opts.sessionId);
  try {
    await ctx.doc.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: ctx.tables.worktrees,
              Key: { id: opts.worktreeId },
              UpdateExpression: "SET #s = :idle, currentSessionId = :null",
              ConditionExpression: "currentSessionId = :sid",
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: { ":idle": "idle", ":null": null, ":sid": opts.sessionId },
            },
          },
          {
            Update: {
              TableName: ctx.tables.sessions,
              Key: { id: opts.sessionId },
              UpdateExpression:
                "SET #s = :queued, statusShard = :statusShard, queueOrder = :queueOrder" +
                ", worktreeId = :null, hostId = :null, errorCode = :code, errorMessage = :message, suppressedTargetIndexes = list_append(if_not_exists(suppressedTargetIndexes, :empty), :index) REMOVE startedAt, ackReceivedAt",
              ConditionExpression:
                "#s = :running AND worktreeId = :worktreeId AND attemptId = :attemptId",
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: {
                ":queued": "queued",
                ":running": "running",
                ":statusShard": statusShardAttr("queued", opts.queueShard),
                ":queueOrder": queueOrder,
                ":null": null,
                ":code": "usage_limit",
                ":message": opts.errorMessage ?? "providerless usage limit; trying fallback",
                ":empty": [],
                ":index": [opts.targetIndex],
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
    if (isConditionalTransactionFailed(err)) return false;
    throw err;
  }
}
