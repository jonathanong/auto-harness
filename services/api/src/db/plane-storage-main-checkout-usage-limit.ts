import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";

import { queueOrderKeyForWrite } from "../control-plane-ordering.ts";
import { statusShardAttr } from "./dynamo.ts";
import {
  isConditionalTransactionFailed,
  itemToSession,
  type PlaneStorageCtx,
} from "./plane-storage-types.ts";

/** Cool an account and requeue its exact scheduled lease for a fallback route. */
export async function requeueMainCheckoutUsageLimitedSession(
  ctx: PlaneStorageCtx,
  opts: {
    sessionId: string;
    hostId: string;
    repositoryId: string;
    connectionId: string;
    attemptId: string;
    providerAccountId: string;
    queueShard: number;
    now: string;
    usageLimitedUntil: string;
    errorMessage?: string | undefined;
  },
): Promise<boolean> {
  const current = await ctx.doc.send(
    new GetCommand({
      TableName: ctx.tables.sessions,
      Key: { id: opts.sessionId },
      ConsistentRead: true,
    }),
  );
  const queueOrder = queueOrderKeyForWrite(
    current.Item ? itemToSession(current.Item as Record<string, unknown>) : undefined,
    opts.sessionId,
  );
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
              TableName: ctx.tables.hostLocks,
              Key: { hostId: opts.hostId },
              UpdateExpression: "REMOVE mainCheckoutLeases.#repo",
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
              UpdateExpression:
                "SET #s = :queued, statusShard = :statusShard, queueOrder = :queueOrder" +
                ", worktreeId = :null, hostId = :null, errorCode = :code, errorMessage = :message REMOVE startedAt, assignmentSentAt, assignmentConnectionId, mainCheckoutLease, ackReceivedAt, reconnectDeadlineAt",
              ConditionExpression:
                "#s = :running AND hostId = :hostId AND assignmentConnectionId = :connectionId AND mainCheckoutLease = :true AND attemptId = :attemptId",
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: {
                ":queued": "queued",
                ":running": "running",
                ":statusShard": statusShardAttr("queued", opts.queueShard),
                ":queueOrder": queueOrder,
                ":null": null,
                ":code": "usage_limit",
                ":message": opts.errorMessage ?? "provider usage limit; requeued",
                ":hostId": opts.hostId,
                ":connectionId": opts.connectionId,
                ":true": true,
                ":attemptId": opts.attemptId,
              },
            },
          },
        ],
      }),
    );
    return true;
  } catch (error) {
    if (isConditionalTransactionFailed(error)) return false;
    throw error;
  }
}
