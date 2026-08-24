import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { SessionStatus } from "@auto-harness/shared";

import {
  compareSessionsForQueue,
  SESSIONS_QUEUE_ORDER_INDEX,
  SESSIONS_STATUS_CREATED_INDEX,
} from "../control-plane-ordering.ts";
import { indexUnavailable, repairQueuedQueueOrder } from "./plane-storage-sessions-queue.ts";
import { statusShardAttr } from "./dynamo.ts";
import { itemToSession, type PlaneStorageCtx } from "./plane-storage-types.ts";
import type { SessionRecord } from "./types.ts";

async function queryStatusPage(
  ctx: PlaneStorageCtx,
  indexName: string,
  status: SessionStatus,
  shard: number,
  limit: number,
): Promise<Record<string, unknown>[]> {
  const result = await ctx.doc.send(
    new QueryCommand({
      TableName: ctx.tables.sessions,
      IndexName: indexName,
      KeyConditionExpression: "statusShard = :ss",
      ExpressionAttributeValues: { ":ss": statusShardAttr(status, shard) },
      Limit: Math.max(1, limit),
    }),
  );
  return (result.Items ?? []) as Record<string, unknown>[];
}

/** Return one bounded page without changing the complete repair listing. */
export async function listSessionsByStatusPage(
  ctx: PlaneStorageCtx,
  status: SessionStatus,
  shard: number,
  limit: number,
): Promise<SessionRecord[]> {
  if (status !== "queued") {
    return (await queryStatusPage(ctx, SESSIONS_STATUS_CREATED_INDEX, status, shard, limit)).map(
      itemToSession,
    );
  }
  let ordered: Record<string, unknown>[] = [];
  try {
    ordered = await queryStatusPage(ctx, SESSIONS_QUEUE_ORDER_INDEX, status, shard, limit);
  } catch (error) {
    if (!indexUnavailable(error)) throw error;
  }
  const legacy = await queryStatusPage(ctx, SESSIONS_STATUS_CREATED_INDEX, status, shard, limit);
  for (const item of legacy) await repairQueuedQueueOrder(ctx, item);
  const byId = new Map<string, Record<string, unknown>>();
  for (const item of [...legacy, ...ordered]) {
    if (typeof item.id === "string") byId.set(item.id, item);
  }
  return [...byId.values()].map(itemToSession).toSorted(compareSessionsForQueue).slice(0, limit);
}
