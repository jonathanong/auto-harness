import { QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import type { SessionStatus } from "@auto-harness/shared";

import {
  compareSessionsForQueue,
  queueOrderKeyForWrite,
  SESSIONS_QUEUE_ORDER_INDEX,
  SESSIONS_CREATED_ORDER_INDEX,
} from "../control-plane-ordering.ts";
import { statusShardAttr } from "./dynamo.ts";
import {
  itemToSession,
  isConditionalTransactionFailed,
  nextPageKey,
  type PlaneStorageCtx,
} from "./plane-storage-types.ts";
import type { SessionRecord } from "./types.ts";
import { getSession } from "./plane-storage-sessions-query.ts";
import {
  readSessionDrainActivity,
  sessionDrainActivityDelete,
} from "./plane-storage-session-drain-activity.ts";

async function querySessionsByStatusIndex(
  ctx: PlaneStorageCtx,
  indexName: string,
  status: SessionStatus,
  shard: number,
): Promise<Record<string, unknown>[]> {
  const records: Record<string, unknown>[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const res = await ctx.doc.send(
      new QueryCommand({
        TableName: ctx.tables.sessions,
        IndexName: indexName,
        KeyConditionExpression: "statusShard = :ss",
        ExpressionAttributeValues: {
          ":ss": statusShardAttr(status, shard),
        },
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }),
    );
    records.push(...((res.Items ?? []) as Record<string, unknown>[]));
    startKey = nextPageKey(res.LastEvaluatedKey as Record<string, unknown> | undefined);
  } while (startKey !== undefined);
  return records;
}

export async function listSessionsByStatus(
  ctx: PlaneStorageCtx,
  status: SessionStatus,
  shard: number,
): Promise<SessionRecord[]> {
  if (status !== "queued") {
    return (
      await querySessionsByStatusIndex(ctx, SESSIONS_CREATED_ORDER_INDEX, status, shard)
    ).map(itemToSession);
  }
  return (await querySessionsByStatusIndex(ctx, SESSIONS_QUEUE_ORDER_INDEX, status, shard))
    .map(itemToSession)
    .toSorted(compareSessionsForQueue);
}

export async function queueOrderForSession(
  ctx: PlaneStorageCtx,
  sessionId: string,
): Promise<string> {
  return queueOrderKeyForWrite(await getSession(ctx, sessionId, true), sessionId);
}

/** Conditionally expire a queued session without requiring a worktree lease. */
export async function expireQueuedSession(
  ctx: PlaneStorageCtx,
  opts: {
    sessionId: string;
    queueShard: number;
    queueExpiresAt: string;
    completedAt: string;
    concurrencyId?: string;
  },
): Promise<boolean> {
  const before = await readSessionDrainActivity(ctx, opts.sessionId);
  try {
    await ctx.doc.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: ctx.tables.sessions,
              Key: { id: opts.sessionId },
              UpdateExpression:
                "SET #s = :failed, statusShard = :statusShard, completedAt = :completedAt, errorCode = :code, errorMessage = :message",
              ConditionExpression: "#s = :queued AND queueExpiresAt = :expiresAt",
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: {
                ":queued": "queued",
                ":failed": "failed",
                ":statusShard": statusShardAttr("failed", opts.queueShard),
                ":completedAt": opts.completedAt,
                ":expiresAt": opts.queueExpiresAt,
                ":code": "queue_expired",
                ":message": "queue TTL expired before capacity became available",
              },
            },
          },
          ...(opts.concurrencyId
            ? [
                {
                  Delete: {
                    TableName: ctx.tables.concurrencyLocks,
                    Key: { concurrencyId: opts.concurrencyId },
                    ConditionExpression:
                      "attribute_not_exists(concurrencyId) OR sessionId = :sessionId",
                    ExpressionAttributeValues: { ":sessionId": opts.sessionId },
                  },
                },
              ]
            : []),
          ...sessionDrainActivityDelete(ctx, before?.activity ?? null),
        ],
      }),
    );
    return true;
  } catch (err) {
    if (isConditionalTransactionFailed(err)) return false;
    throw err;
  }
}
