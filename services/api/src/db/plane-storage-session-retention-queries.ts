import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { SessionStatus } from "@auto-harness/shared";

import { statusShardAttr } from "./dynamo.ts";
import { SESSION_RETENTION_INDEX } from "./ensure-session-retention-index.ts";
import { getSession } from "./plane-storage-sessions-query.ts";
import { nextPageKey, type PlaneStorageCtx } from "./plane-storage-types.ts";
import type { RetentionJob } from "./plane-storage-session-retention-types.ts";
import type { SessionRecord } from "./types.ts";

const JOB_SCOPE = "__retention#v1#jobs";
const CURSOR_SCOPE = "__retention#v1#cursors";

export function getRetentionSession(
  ctx: PlaneStorageCtx,
  id: string,
): Promise<SessionRecord | null> {
  return getSession(ctx, id, true);
}

export async function nextRetentionPartition(ctx: PlaneStorageCtx, count: number): Promise<number> {
  const result = await ctx.doc.send(
    new UpdateCommand({
      TableName: ctx.tables.sessionDrains,
      Key: { scopeKey: CURSOR_SCOPE, recordKey: "PARTITION" },
      UpdateExpression: "ADD partitionNumber :one",
      ExpressionAttributeValues: { ":one": 1 },
      ReturnValues: "UPDATED_OLD",
    }),
  );
  return ((result.Attributes?.partitionNumber as number | undefined) ?? 0) % count;
}

export async function loadRetentionCursor(
  ctx: PlaneStorageCtx,
  name: string,
): Promise<Record<string, unknown> | undefined> {
  const result = await ctx.doc.send(
    new GetCommand({
      TableName: ctx.tables.sessionDrains,
      Key: { scopeKey: CURSOR_SCOPE, recordKey: name },
      ConsistentRead: true,
    }),
  );
  return nextPageKey(result.Item?.nextKey as Record<string, unknown> | undefined);
}

export async function saveRetentionCursor(
  ctx: PlaneStorageCtx,
  name: string,
  nextKey?: Record<string, unknown>,
): Promise<void> {
  await ctx.doc.send(
    new PutCommand({
      TableName: ctx.tables.sessionDrains,
      Item: { scopeKey: CURSOR_SCOPE, recordKey: name, ...(nextKey ? { nextKey } : {}) },
    }),
  );
}

export async function listRetentionCandidates(
  ctx: PlaneStorageCtx,
  status: SessionStatus,
  shard: number,
  cutoff: string,
  limit: number,
  startKey?: Record<string, unknown>,
) {
  const result = await ctx.doc.send(
    new QueryCommand({
      TableName: ctx.tables.sessions,
      IndexName: SESSION_RETENTION_INDEX,
      KeyConditionExpression: "statusShard = :statusShard AND completedAt <= :cutoff",
      ExpressionAttributeValues: {
        ":statusShard": statusShardAttr(status, shard),
        ":cutoff": cutoff,
      },
      Limit: limit,
      ...(startKey ? { ExclusiveStartKey: startKey } : {}),
    }),
  );
  return {
    records: (result.Items ?? []) as Array<{
      id: string;
      completedAt: string;
      statusShard: string;
    }>,
    nextKey: nextPageKey(result.LastEvaluatedKey as Record<string, unknown> | undefined),
  };
}

export async function listRetentionJobs(
  ctx: PlaneStorageCtx,
  now: string,
  limit: number,
  startKey?: Record<string, unknown>,
) {
  const result = await ctx.doc.send(
    new QueryCommand({
      TableName: ctx.tables.sessionDrains,
      ConsistentRead: true,
      KeyConditionExpression: "scopeKey = :scope AND recordKey <= :due",
      ExpressionAttributeValues: { ":scope": JOB_SCOPE, ":due": `${now}#\uffff` },
      Limit: limit,
      ...(startKey ? { ExclusiveStartKey: startKey } : {}),
    }),
  );
  return {
    records: (result.Items ?? []) as RetentionJob[],
    nextKey: nextPageKey(result.LastEvaluatedKey as Record<string, unknown> | undefined),
  };
}
