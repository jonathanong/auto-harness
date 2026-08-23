import { QueryCommand } from "@aws-sdk/lib-dynamodb";

import { nextPageKey, type PlaneStorageCtx } from "./plane-storage-types.ts";

const REPOSITORY_INDEX = "repositoryId-id";

async function countRepositoryRows(
  ctx: PlaneStorageCtx,
  tableName: string,
  repositoryId: string,
  hostId?: string,
): Promise<number> {
  let count = 0;
  let startKey: Record<string, unknown> | undefined;
  do {
    const response = await ctx.doc.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: REPOSITORY_INDEX,
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
    count += response.Count ?? 0;
    startKey = nextPageKey(response.LastEvaluatedKey as Record<string, unknown> | undefined);
  } while (startKey !== undefined);
  return count;
}

export function countWorktreesByRepository(
  ctx: PlaneStorageCtx,
  repositoryId: string,
  hostId?: string,
): Promise<number> {
  return countRepositoryRows(ctx, ctx.tables.worktrees, repositoryId, hostId);
}

export function countSchedulesByRepository(
  ctx: PlaneStorageCtx,
  repositoryId: string,
): Promise<number> {
  return countRepositoryRows(ctx, ctx.tables.schedules, repositoryId);
}
