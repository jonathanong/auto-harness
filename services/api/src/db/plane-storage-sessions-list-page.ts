import { SESSION_STATUSES, type SessionStatus } from "@auto-harness/shared";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";

import {
  SESSIONS_QUEUE_ORDER_INDEX,
  SESSIONS_STATUS_CREATED_INDEX,
} from "../control-plane-ordering.ts";
import type { SessionListSort } from "../control-plane-session-cursor.ts";
import { compareSessionToCursor, compareSessions } from "../control-plane-session-order.ts";
import { statusShardAttr } from "./dynamo.ts";
import { itemToSession, nextPageKey, type PlaneStorageCtx } from "./plane-storage-types.ts";
import type { SessionRecord } from "./types.ts";

const SESSIONS_REPOSITORY_INDEX = "repositoryId-createdAt";

export type SessionListPageQuery = {
  limit: number;
  sort: SessionListSort;
  shardCount: number;
  status: SessionStatus | null;
  repositoryId: string | null;
  repositoryIds: string[] | null;
  hostId: string | null;
  source: string | null;
  concurrencyId: string | null;
  scheduleId: string | null;
  position?: { createdAt: string; id: string; priority: number };
};

/** Bounded Query of the next session window. Never Scans the Sessions table. */
export async function listSessionsPageFromStorage(
  ctx: PlaneStorageCtx,
  query: SessionListPageQuery,
): Promise<SessionRecord[]> {
  const needed = query.limit + 1;
  const repositories = repositoryKeys(query);
  if (repositories !== undefined && repositories.length === 0) return [];
  const pages =
    repositories !== undefined
      ? await Promise.all(
          repositories.map((repositoryId) =>
            queryRepositoryWindow(ctx, query, repositoryId, needed),
          ),
        )
      : await Promise.all(
          statuses(query).flatMap((status) =>
            [...Array(query.shardCount).keys()].map((shard) =>
              queryStatusWindow(ctx, query, status, shard, needed),
            ),
          ),
        );
  return pages
    .flat()
    .filter((session) => matchesFilters(session, query) && afterCursor(session, query))
    .toSorted((a, b) => compareSessions(a, b, query.sort))
    .slice(0, needed);
}

function repositoryKeys(query: SessionListPageQuery): string[] | undefined {
  if (query.repositoryId) {
    if (query.repositoryIds && !query.repositoryIds.includes(query.repositoryId)) return [];
    return [query.repositoryId];
  }
  return query.repositoryIds === null ? undefined : [...query.repositoryIds];
}

function statuses(query: SessionListPageQuery): readonly SessionStatus[] {
  return query.status ? [query.status] : SESSION_STATUSES;
}

function matchesFilters(session: SessionRecord, query: SessionListPageQuery): boolean {
  return (
    (query.status === null || session.status === query.status) &&
    (query.hostId === null || session.hostId === query.hostId) &&
    (query.source === null || session.source === query.source) &&
    (query.concurrencyId === null || session.concurrencyId === query.concurrencyId) &&
    (query.scheduleId === null || session.scheduleId === query.scheduleId) &&
    (query.repositoryIds === null || query.repositoryIds.includes(session.repositoryId))
  );
}

function afterCursor(session: SessionRecord, query: SessionListPageQuery): boolean {
  return !query.position || compareSessionToCursor(session, query.position, query.sort) > 0;
}

async function queryRepositoryWindow(
  ctx: PlaneStorageCtx,
  query: SessionListPageQuery,
  repositoryId: string,
  limit: number,
): Promise<SessionRecord[]> {
  return queryWindow(ctx, {
    indexName: SESSIONS_REPOSITORY_INDEX,
    keyName: "repositoryId",
    keyValue: repositoryId,
    forward: query.sort !== "latest",
    limit,
    ...(query.position?.createdAt ? { createdAt: query.position.createdAt } : {}),
    latest: query.sort === "latest",
  });
}

async function queryStatusWindow(
  ctx: PlaneStorageCtx,
  query: SessionListPageQuery,
  status: SessionStatus,
  shard: number,
  limit: number,
): Promise<SessionRecord[]> {
  const queuedPriority = status === "queued" && query.sort.startsWith("priority_");
  return queryWindow(ctx, {
    indexName: queuedPriority ? SESSIONS_QUEUE_ORDER_INDEX : SESSIONS_STATUS_CREATED_INDEX,
    keyName: "statusShard",
    keyValue: statusShardAttr(status, shard),
    forward: queuedPriority ? query.sort !== "priority_desc" : query.sort !== "latest",
    limit,
    ...(!queuedPriority && query.position?.createdAt
      ? { createdAt: query.position.createdAt }
      : {}),
    latest: query.sort === "latest",
  });
}

async function queryWindow(
  ctx: PlaneStorageCtx,
  input: {
    indexName: string;
    keyName: string;
    keyValue: string;
    forward: boolean;
    limit: number;
    createdAt?: string;
    latest: boolean;
  },
): Promise<SessionRecord[]> {
  const records: SessionRecord[] = [];
  let startKey: Record<string, unknown> | undefined;
  const createdBound = input.createdAt
    ? input.latest
      ? `${input.keyName} = :key AND createdAt <= :createdAt`
      : `${input.keyName} = :key AND createdAt >= :createdAt`
    : `${input.keyName} = :key`;
  do {
    const res = await ctx.doc.send(
      new QueryCommand({
        TableName: ctx.tables.sessions,
        IndexName: input.indexName,
        KeyConditionExpression:
          input.indexName === SESSIONS_QUEUE_ORDER_INDEX ? "#key = :key" : createdBound,
        ExpressionAttributeNames:
          input.indexName === SESSIONS_QUEUE_ORDER_INDEX ? { "#key": input.keyName } : undefined,
        ExpressionAttributeValues: {
          ":key": input.keyValue,
          ...(input.createdAt && input.indexName !== SESSIONS_QUEUE_ORDER_INDEX
            ? { ":createdAt": input.createdAt }
            : {}),
        },
        ScanIndexForward: input.forward,
        Limit: input.limit,
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }),
    );
    records.push(
      ...(res.Items ?? []).map((item) => itemToSession(item as Record<string, unknown>)),
    );
    startKey = nextPageKey(res.LastEvaluatedKey as Record<string, unknown> | undefined);
  } while (startKey && records.length < input.limit);
  return records.slice(0, input.limit);
}
