import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { SessionStatus } from "@auto-harness/shared";

import {
  compareSessionsForQueue,
  SESSIONS_QUEUE_ORDER_INDEX,
  SESSIONS_CREATED_ORDER_INDEX,
} from "../control-plane-ordering.ts";
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
    return (await queryStatusPage(ctx, SESSIONS_CREATED_ORDER_INDEX, status, shard, limit)).map(
      itemToSession,
    );
  }
  return (await queryStatusPage(ctx, SESSIONS_QUEUE_ORDER_INDEX, status, shard, limit))
    .map(itemToSession)
    .toSorted(compareSessionsForQueue)
    .slice(0, limit);
}
