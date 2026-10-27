import { QueryCommand } from "@aws-sdk/lib-dynamodb";

import {
  createdOrderKey,
  priorityOrderKey,
  repositoryPriorityOrderKey,
} from "../control-plane-ordering.ts";
import type {
  SessionCursorV2,
  SessionPartitionCheckpoint,
} from "../control-plane-session-cursor.ts";
import { compareSessionToCursor, compareSessions } from "../control-plane-session-order.ts";
import type { SessionListPageQuery } from "./plane-storage-sessions-list-page.ts";
import { itemToSession, nextPageKey, type PlaneStorageCtx } from "./plane-storage-types.ts";
import type { SessionRecord } from "./types.ts";

export type Partition = {
  id: string;
  indexName: string;
  keyName: "statusShard";
  keyValue: string;
  forward: boolean;
  sortKeyName: "createdOrder" | "priorityOrder" | "repositoryPriorityOrder";
  sortKeyRange?: { start: string; end: string };
  repositoryId?: string;
};
export type RawRow = { item: Record<string, unknown>; session: SessionRecord; matching: boolean };
export type PartitionState = SessionCursorV2["partitions"][number];
export type PartitionWindow = {
  partition: Partition;
  previous: PartitionState;
  /** Rows read so far this request, contiguous in index order across refills. */
  rows: RawRow[];
  nextKey: SessionPartitionCheckpoint | undefined;
  exhaustedRead: boolean;
  /** Sum of Query `Limit`s sent for this partition; never exceeds `limit + 1`. */
  requested: number;
};

/**
 * Session rows are large (~20KB with prompt and argv), so a full `limit + 1` read from
 * every status/shard partition pulls megabytes for one page. Start each partition with
 * an even share of the page and refill only partitions that hold the page back.
 */
export function initialWindowLimit(limit: number, partitionCount: number): number {
  return Math.min(limit + 1, Math.ceil(limit / partitionCount) + 1);
}

/** Read the first window of a partition, resuming at its stored checkpoint. */
export async function openPartitionWindow(
  ctx: PlaneStorageCtx,
  query: SessionListPageQuery,
  partition: Partition,
  previous: PartitionState,
  limit: number,
): Promise<PartitionWindow> {
  const window: PartitionWindow = {
    partition,
    previous,
    rows: [],
    nextKey: previous.checkpoint ?? undefined,
    exhaustedRead: false,
    requested: 0,
  };
  await readPartition(ctx, query, window, limit);
  return window;
}

/**
 * Read the next window of a partition, doubling what it has read so far. A partition's
 * reads stop at `limit + 1` rows in total, the single read this list made before
 * windows, so a page never reads more than that and refills take O(log limit) rounds.
 */
export async function extendPartitionWindow(
  ctx: PlaneStorageCtx,
  query: SessionListPageQuery,
  window: PartitionWindow,
): Promise<void> {
  await readPartition(
    ctx,
    query,
    window,
    Math.min(window.requested, query.limit + 1 - window.requested),
  );
}

/** Open partitions that may still hold a row of this page and have read budget left. */
export function refillableWindows(
  windows: readonly PartitionWindow[],
  query: SessionListPageQuery,
): PartitionWindow[] {
  // A partition whose frontier is already past the limit-th matching row read so far
  // cannot contribute to this page; every other open partition might.
  const threshold = windows
    .flatMap((window) => window.rows.filter((row) => row.matching).map((row) => row.session))
    .toSorted((a, b) => compareSessions(a, b, query.sort))
    .at(query.limit - 1);
  return windows.filter((window) => {
    if (window.exhaustedRead || window.requested > query.limit) return false;
    const frontier = window.rows.at(-1)?.session;
    return (
      frontier === undefined ||
      threshold === undefined ||
      compareSessions(frontier, threshold, query.sort) < 0
    );
  });
}

export function validCheckpoint(
  checkpoint: SessionPartitionCheckpoint | null,
  partition: Partition,
): boolean {
  if (checkpoint === null) return true;
  const expected = ["id", partition.keyName, partition.sortKeyName];
  return (
    Object.keys(checkpoint).length === expected.length &&
    expected.every((key) => typeof checkpoint[key] === "string") &&
    checkpoint[partition.keyName] === partition.keyValue
  );
}

function matchesFilters(session: SessionRecord, query: SessionListPageQuery): boolean {
  return (
    (query.status === null || session.status === query.status) &&
    (query.repositoryId === null || session.repositoryId === query.repositoryId) &&
    (query.hostId === null || session.hostId === query.hostId) &&
    (!query.worktreeId || session.worktreeId === query.worktreeId) &&
    (query.source === null || session.source === query.source) &&
    (query.concurrencyId === null || session.concurrencyId === query.concurrencyId) &&
    (query.scheduleId === null || session.scheduleId === query.scheduleId) &&
    (query.repositoryIds === null || query.repositoryIds.includes(session.repositoryId)) &&
    (!query.position || compareSessionToCursor(session, query.position, query.sort) > 0)
  );
}

async function readPartition(
  ctx: PlaneStorageCtx,
  query: SessionListPageQuery,
  window: PartitionWindow,
  limit: number,
): Promise<void> {
  const { partition } = window;
  // A checkpoint already positions the read. DynamoDB rejects an ExclusiveStartKey
  // outside the key condition, and a partition's checkpoint is usually newer than the
  // page's last emitted row, so bind the cursor position only when there is none.
  // matchesFilters still drops rows at or before the position.
  const legacySortValue =
    query.position && !window.nextKey
      ? partition.sortKeyName === "createdOrder"
        ? createdOrderKey(query.position)
        : partition.sortKeyName === "priorityOrder"
          ? priorityOrderKey(query.position)
          : repositoryPriorityOrderKey(partition.repositoryId!, query.position)
      : undefined;
  const range = partition.sortKeyRange
    ? {
        start:
          legacySortValue && partition.forward ? legacySortValue : partition.sortKeyRange.start,
        end: legacySortValue && !partition.forward ? legacySortValue : partition.sortKeyRange.end,
      }
    : undefined;
  const condition = range
    ? `${partition.keyName} = :key AND ${partition.sortKeyName} BETWEEN :sortStart AND :sortEnd`
    : legacySortValue
      ? `${partition.keyName} = :key AND ${partition.sortKeyName} ${
          partition.sortKeyName === "createdOrder"
            ? partition.forward
              ? ">="
              : "<="
            : partition.forward
              ? ">"
              : "<"
        } :sortValue`
      : `${partition.keyName} = :key`;
  const response = await ctx.doc.send(
    new QueryCommand({
      TableName: ctx.tables.sessions,
      IndexName: partition.indexName,
      KeyConditionExpression: condition,
      ExpressionAttributeValues: {
        ":key": partition.keyValue,
        ...(range ? { ":sortStart": range.start, ":sortEnd": range.end } : {}),
        ...(!range && legacySortValue ? { ":sortValue": legacySortValue } : {}),
      },
      ScanIndexForward: partition.forward,
      Limit: limit,
      ...(window.nextKey ? { ExclusiveStartKey: window.nextKey } : {}),
    }),
  );
  for (const item of response.Items ?? []) {
    const raw = item as Record<string, unknown>;
    const session = itemToSession(raw);
    window.rows.push({ item: raw, session, matching: matchesFilters(session, query) });
  }
  window.nextKey = typedPageKey(
    response.LastEvaluatedKey as Record<string, unknown> | undefined,
    partition,
  );
  window.exhaustedRead = window.nextKey === undefined;
  window.requested += limit;
}

function typedPageKey(
  key: Record<string, unknown> | undefined,
  partition: Partition,
): SessionPartitionCheckpoint | undefined {
  const normalized = nextPageKey(key);
  if (!normalized) return undefined;
  if (Object.values(normalized).some((value) => typeof value !== "string")) {
    throw new Error("session query returned an invalid pagination key");
  }
  const typed = normalized as SessionPartitionCheckpoint;
  if (!validCheckpoint(typed, partition))
    throw new Error("session query returned an invalid pagination key");
  return typed;
}
