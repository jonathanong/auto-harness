import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";

import { nextPageKey, type PlaneStorageCtx } from "./plane-storage-types.ts";
import { getSession } from "./plane-storage-sessions-query.ts";
import type { SessionRecord } from "./types.ts";

export const SESSIONS_ACTIVE_HOST_INDEX = "activeHostId-activeHostOrder";
const ACTIVE_HOST_PAGE_SIZE = 25;
const ACTIVE_HOST_QUERY_ATTEMPTS = 3;
const ACTIVE_HOST_QUERY_RETRY_MS = 25;

/** A host claim is indexed only while it still needs host-side reconciliation. */
export function activeHostOrder(assignedAt: string, sessionId: string): string {
  return `${assignedAt}#${sessionId}`;
}

/** Query active claims for exactly one host. This path intentionally has no scan fallback. */
export async function listActiveSessionsByHost(
  ctx: PlaneStorageCtx,
  hostId: string,
): Promise<SessionRecord[]> {
  for (let attempt = 1; attempt <= ACTIVE_HOST_QUERY_ATTEMPTS; attempt++) {
    const result = await listActiveSessionsByHostOnce(ctx, hostId);
    if (result.complete) return result.records;
    if (attempt < ACTIVE_HOST_QUERY_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, ACTIVE_HOST_QUERY_RETRY_MS * attempt));
    }
  }
  throw new Error(`active host claim index did not converge for ${hostId}`);
}

async function listActiveSessionsByHostOnce(
  ctx: PlaneStorageCtx,
  hostId: string,
): Promise<{ complete: boolean; records: SessionRecord[] }> {
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
  // assignment. Retry a lagging GSI, then fail closed: disconnect/recovery callers retain
  // the durable host lease and the scheduled stale-host pass retries this operation.
  const complete = !(
    typeof assignmentCount === "number" &&
    Number.isSafeInteger(assignmentCount) &&
    assignmentCount > records.length
  );
  return { complete, records };
}
