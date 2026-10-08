import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";

import { repositoryActivityScope } from "./plane-storage-operational-activity.ts";
import { nextPageKey, type PlaneStorageCtx } from "./plane-storage-types.ts";

export async function loadRepositoryActivityCursor(
  ctx: PlaneStorageCtx,
  repositoryId: string,
  drainRequestedAt: string,
): Promise<Record<string, unknown> | undefined> {
  const result = await ctx.doc.send(
    new GetCommand({
      TableName: ctx.tables.sessionDrains,
      Key: { scopeKey: repositoryActivityScope(repositoryId), recordKey: "DRAIN-CURSOR" },
      ConsistentRead: true,
    }),
  );
  if (result.Item?.drainRequestedAt !== drainRequestedAt) return undefined;
  return nextPageKey(result.Item.nextKey as Record<string, unknown> | undefined);
}

export async function saveRepositoryActivityCursor(
  ctx: PlaneStorageCtx,
  repositoryId: string,
  drainRequestedAt: string,
  nextKey?: Record<string, unknown>,
): Promise<void> {
  await ctx.doc.send(
    new PutCommand({
      TableName: ctx.tables.sessionDrains,
      Item: {
        scopeKey: repositoryActivityScope(repositoryId),
        recordKey: "DRAIN-CURSOR",
        drainRequestedAt,
        ...(nextKey ? { nextKey } : {}),
      },
    }),
  );
}
