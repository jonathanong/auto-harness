import { GetCommand, QueryCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";

import type { SessionRecord } from "./types.ts";
import { itemToSession, nextPageKey, type PlaneStorageCtx } from "./plane-storage-types.ts";

const SESSIONS_REPOSITORY_INDEX = "repositoryId-createdAt";

export async function getSession(
  ctx: PlaneStorageCtx,
  id: string,
  consistentRead = false,
): Promise<SessionRecord | null> {
  const res = await ctx.doc.send(
    new GetCommand({
      TableName: ctx.tables.sessions,
      Key: { id },
      ...(consistentRead ? { ConsistentRead: true } : {}),
    }),
  );
  return res.Item ? itemToSession(res.Item) : null;
}

export async function listAllSessions(
  ctx: PlaneStorageCtx,
  consistentRead = false,
): Promise<SessionRecord[]> {
  const items: Record<string, unknown>[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const res = await ctx.doc.send(
      new ScanCommand({
        ...(consistentRead ? { ConsistentRead: true } : {}),
        TableName: ctx.tables.sessions,
        ExclusiveStartKey: startKey,
      }),
    );
    items.push(...((res.Items ?? []) as Record<string, unknown>[]));
    startKey = nextPageKey(res.LastEvaluatedKey as Record<string, unknown> | undefined);
  } while (startKey !== undefined);
  return items.map(itemToSession);
}

/** Query the repository access path; callers apply the remaining filters locally. */
export async function listSessionsByRepository(
  ctx: PlaneStorageCtx,
  repositoryId: string,
): Promise<SessionRecord[]> {
  try {
    const records: SessionRecord[] = [];
    let startKey: Record<string, unknown> | undefined;
    do {
      const res = await ctx.doc.send(
        new QueryCommand({
          TableName: ctx.tables.sessions,
          IndexName: SESSIONS_REPOSITORY_INDEX,
          KeyConditionExpression: "repositoryId = :repositoryId",
          ExpressionAttributeValues: { ":repositoryId": repositoryId },
          ScanIndexForward: true,
          ...(startKey ? { ExclusiveStartKey: startKey } : {}),
        }),
      );
      records.push(
        ...(res.Items ?? []).map((item) => itemToSession(item as Record<string, unknown>)),
      );
      startKey = nextPageKey(res.LastEvaluatedKey as Record<string, unknown> | undefined);
    } while (startKey !== undefined);
    return records;
  } catch (error) {
    if (!isRepositoryIndexUnavailable(error)) throw error;
    return listSessionsByRepositoryScan(ctx, repositoryId);
  }
}

/** Count a repository's sessions without materializing its retained history. */
export async function countSessionsByRepository(
  ctx: PlaneStorageCtx,
  repositoryId: string,
  hostId?: string,
): Promise<number> {
  let count = 0;
  let startKey: Record<string, unknown> | undefined;
  do {
    const res = await ctx.doc.send(
      new QueryCommand({
        TableName: ctx.tables.sessions,
        IndexName: SESSIONS_REPOSITORY_INDEX,
        KeyConditionExpression: "repositoryId = :repositoryId",
        ExpressionAttributeValues: {
          ":repositoryId": repositoryId,
          ...(hostId ? { ":hostId": hostId } : {}),
        },
        ...(hostId ? { FilterExpression: "hostId = :hostId" } : {}),
        Select: "COUNT",
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }),
    );
    count += res.Count ?? 0;
    startKey = nextPageKey(res.LastEvaluatedKey as Record<string, unknown> | undefined);
  } while (startKey !== undefined);
  return count;
}

function isRepositoryIndexUnavailable(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: unknown }).name === "ValidationException"
  );
}

/** Compatibility path while an existing table's new GSI is being created. */
async function listSessionsByRepositoryScan(
  ctx: PlaneStorageCtx,
  repositoryId: string,
): Promise<SessionRecord[]> {
  const records: SessionRecord[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const res = await ctx.doc.send(
      new ScanCommand({
        TableName: ctx.tables.sessions,
        FilterExpression: "repositoryId = :repositoryId",
        ExpressionAttributeValues: { ":repositoryId": repositoryId },
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }),
    );
    records.push(
      ...(res.Items ?? []).map((item) => itemToSession(item as Record<string, unknown>)),
    );
    startKey = nextPageKey(res.LastEvaluatedKey as Record<string, unknown> | undefined);
  } while (startKey !== undefined);
  return records;
}
