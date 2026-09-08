import { QueryCommand } from "@aws-sdk/lib-dynamodb";

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
    records.push(...page.filter((session): session is SessionRecord => session !== null));
    startKey = nextPageKey(result.LastEvaluatedKey as Record<string, unknown> | undefined);
  } while (startKey !== undefined);
  return records;
}
