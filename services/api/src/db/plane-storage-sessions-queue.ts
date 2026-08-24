import { QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { SessionStatus } from "@auto-harness/shared";

import {
  compareSessionsForQueue,
  queueOrderKey,
  queueOrderKeyForWrite,
  SESSIONS_QUEUE_ORDER_INDEX,
  SESSIONS_STATUS_CREATED_INDEX,
} from "../control-plane-ordering.ts";
import { statusShardAttr } from "./dynamo.ts";
import {
  itemToSession,
  isConditionalFailed,
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

function indexUnavailable(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: unknown }).name === "ValidationException" &&
    "message" in error &&
    typeof (error as { message?: unknown }).message === "string" &&
    /index|backfill/i.test((error as { message: string }).message)
  );
}

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

async function repairQueuedQueueOrder(
  ctx: PlaneStorageCtx,
  item: Record<string, unknown>,
): Promise<void> {
  if (
    item.status !== "queued" ||
    typeof item.queueOrder === "string" ||
    typeof item.id !== "string" ||
    typeof item.createdAt !== "string" ||
    typeof item.priority !== "number"
  ) {
    return;
  }
  try {
    await ctx.doc.send(
      new UpdateCommand({
        TableName: ctx.tables.sessions,
        Key: { id: item.id },
        UpdateExpression: "SET queueOrder = :queueOrder",
        ConditionExpression: "#s = :queued AND attribute_not_exists(queueOrder)",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":queued": "queued",
          ":queueOrder": queueOrderKey({
            id: item.id,
            createdAt: item.createdAt,
            priority: item.priority,
          }),
        },
      }),
    );
  } catch (error) {
    if (!isConditionalFailed(error)) throw error;
  }
}

export async function listSessionsByStatus(
  ctx: PlaneStorageCtx,
  status: SessionStatus,
  shard: number,
): Promise<SessionRecord[]> {
  // Running/terminal listings keep createdAt so pre-index rows remain visible.
  // Queued listings union both indexes until queueOrder backfill is complete —
  // a live sparse GSI omits items missing the sort key without throwing.
  if (status !== "queued") {
    return (
      await querySessionsByStatusIndex(ctx, SESSIONS_STATUS_CREATED_INDEX, status, shard)
    ).map(itemToSession);
  }
  let ordered: Record<string, unknown>[] = [];
  try {
    ordered = await querySessionsByStatusIndex(ctx, SESSIONS_QUEUE_ORDER_INDEX, status, shard);
  } catch (error) {
    if (!indexUnavailable(error)) throw error;
  }
  const legacy = await querySessionsByStatusIndex(
    ctx,
    SESSIONS_STATUS_CREATED_INDEX,
    status,
    shard,
  );
  for (const item of legacy) await repairQueuedQueueOrder(ctx, item);
  const byId = new Map<string, Record<string, unknown>>();
  for (const item of [...legacy, ...ordered]) {
    if (typeof item.id === "string") byId.set(item.id, item);
  }
  return [...byId.values()].map(itemToSession).toSorted(compareSessionsForQueue);
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
