import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";

import { nextPageKey, type PlaneStorageCtx } from "./plane-storage-types.ts";
import { getSession } from "./plane-storage-sessions-query.ts";
import type { SessionRecord } from "./types.ts";

export const SESSIONS_ACTIVE_HOST_INDEX = "activeHostId-activeHostOrder";
const ACTIVE_HOST_PAGE_SIZE = 25;

/** A host claim is indexed only while it still needs host-side reconciliation. */
export function activeHostOrder(assignedAt: string, sessionId: string): string {
  return `${assignedAt}#${sessionId}`;
}

/** Query active claims for exactly one host. This path intentionally has no scan fallback. */
export async function listActiveSessionsByHost(
  ctx: PlaneStorageCtx,
  hostId: string,
): Promise<SessionRecord[]> {
  const records: SessionRecord[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const result = await ctx.doc.send(
      new QueryCommand({
        TableName: ctx.tables.sessions,
        IndexName: SESSIONS_ACTIVE_HOST_INDEX,
        KeyConditionExpression: "activeHostId = :hostId",
        ExpressionAttributeValues: { ":hostId": hostId },
        Limit: ACTIVE_HOST_PAGE_SIZE,
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }),
    );
    const ids: string[] = [];
    for (const item of result.Items ?? []) {
      if (typeof (item as Record<string, unknown>).id === "string") {
        ids.push((item as { id: string }).id);
      }
    }
    const page = await Promise.all(ids.map((id) => getSession(ctx, id, true)));
    records.push(
      ...page.filter(
        (session): session is SessionRecord => session !== null && session.activeHostId === hostId,
      ),
    );
    startKey = nextPageKey(result.LastEvaluatedKey as Record<string, unknown> | undefined);
  } while (startKey !== undefined);
  const hostLock = await ctx.doc.send(
    new GetCommand({
      TableName: ctx.tables.hostLocks,
      Key: { hostId },
      ConsistentRead: true,
    }),
  );
  const assignmentCount = hostLock.Item?.assignmentCount;
  // The base-table counter is updated transactionally with every fresh-environment
  // assignment. Fail closed while the GSI is behind: disconnect/recovery callers then
  // retain the durable host lease, and the scheduled stale-host pass retries this query.
  if (
    typeof assignmentCount === "number" &&
    Number.isSafeInteger(assignmentCount) &&
    assignmentCount > records.length
  ) {
    throw new Error(
      `active host claim index has ${records.length} of ${assignmentCount} assignments for ${hostId}`,
    );
  }
  return records;
}
