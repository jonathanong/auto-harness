import { GetCommand } from "@aws-sdk/lib-dynamodb";

import type { PlaneStorageCtx } from "./plane-storage-types.ts";

export async function getMainCheckoutCursor(
  ctx: PlaneStorageCtx,
  hostId: string,
): Promise<string | null> {
  const result = await ctx.doc.send(
    new GetCommand({ TableName: ctx.tables.hostLocks, Key: { hostId } }),
  );
  return (result.Item?.lastScheduledAssignedAt as string | undefined) ?? null;
}

export async function getMainCheckoutLease(
  ctx: PlaneStorageCtx,
  hostId: string,
  repositoryId: string,
): Promise<{ sessionId: string; connectionId: string } | null> {
  const result = await ctx.doc.send(
    new GetCommand({ TableName: ctx.tables.hostLocks, Key: { hostId } }),
  );
  const lease = (result.Item?.mainCheckoutLeases as Record<string, unknown> | undefined)?.[
    repositoryId
  ];
  return lease && typeof lease === "object"
    ? (lease as { sessionId: string; connectionId: string })
    : null;
}
