/* eslint-disable max-lines -- bounded partition planning and cursor advancement are coupled. */
import { SESSION_STATUSES, type SessionStatus } from "@auto-harness/shared";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";

import {
  createdOrderKey,
  SESSIONS_CREATED_ORDER_INDEX,
  priorityOrderKey,
  repositoryPriorityOrderKey,
  repositoryPriorityOrderRange,
  SESSIONS_PRIORITY_ORDER_INDEX,
  SESSIONS_REPOSITORY_PRIORITY_ORDER_INDEX,
} from "../control-plane-ordering.ts";
import type {
  CursorPosition,
  SessionCursorV2,
  SessionListSort,
  SessionPartitionCheckpoint,
} from "../control-plane-session-cursor.ts";
import { InvalidSessionCursorError } from "../control-plane-session-cursor.ts";
import { compareSessionToCursor, compareSessions } from "../control-plane-session-order.ts";
import { statusShardAttr } from "./dynamo.ts";
import { itemToSession, nextPageKey, type PlaneStorageCtx } from "./plane-storage-types.ts";
import type { SessionRecord } from "./types.ts";

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
  /** Logical emitted-item boundary carried by both legacy and partition cursors. */
  position?: CursorPosition;
  continuation?: SessionCursorV2;
};

export type SessionStoragePage = {
  items: SessionRecord[];
  /** Null is the sole terminal signal; sparse filters can produce an empty page. */
  continuation: SessionCursorV2["partitions"] | null;
};

type Partition = {
  id: string;
  indexName: string;
  keyName: "statusShard";
  keyValue: string;
  forward: boolean;
  sortKeyName: "createdOrder" | "priorityOrder" | "repositoryPriorityOrder";
  sortKeyRange?: { start: string; end: string };
  repositoryId?: string;
};
type RawRow = { item: Record<string, unknown>; session: SessionRecord; matching: boolean };
type PartitionState = SessionCursorV2["partitions"][number];
type PartitionWindow = {
  partition: Partition;
  previous: PartitionState;
  rows: RawRow[];
  nextKey: SessionPartitionCheckpoint | undefined;
  exhaustedRead: boolean;
};

/** One raw Query per selected partition. Never scans or loops a sparse partition. */
export async function listSessionsPageFromStorage(
  ctx: PlaneStorageCtx,
  query: SessionListPageQuery,
): Promise<SessionStoragePage> {
  const partitions = partitionPlan(query);
  if (partitions.length === 0) return { items: [], continuation: null };
  const states = continuationForPlan(query.continuation, partitions);
  // A status transition can move an un-emitted row into a partition that was
  // exhausted on an earlier page. While another partition still carries the
  // traversal forward, restart exhausted unfiltered partitions at the logical
  // cursor bound; that bound suppresses emitted rows without losing the move.
  const revisitExhausted =
    query.status === null &&
    query.position !== undefined &&
    [...states.values()].some((state) => !state.exhausted);
  const windows = await Promise.all(
    partitions.map(async (partition) => {
      const stored = states.get(partition.id)!;
      const previous =
        revisitExhausted && stored.exhausted
          ? { id: stored.id, checkpoint: null, exhausted: false }
          : stored;
      return previous.exhausted
        ? { partition, previous, rows: [], nextKey: undefined, exhaustedRead: true }
        : queryPartitionWindow(ctx, query, partition, previous);
    }),
  );
  const candidates = windows
    .flatMap((window) => window.rows.filter((row) => row.matching).map((row) => ({ window, row })))
    .toSorted((a, b) => compareSessions(a.row.session, b.row.session, query.sort));

  // An open partition's unqueried tail begins after its raw frontier. A candidate
  // is safe only when every such frontier is at or after it in list order.
  const safe = candidates.filter(({ row }) =>
    windows.every((window) => {
      if (window.exhaustedRead) return true;
      const frontier = window.rows.at(-1)?.session;
      return frontier !== undefined && compareSessions(row.session, frontier, query.sort) <= 0;
    }),
  );
  const selected = selectConsumable(safe, query.limit);
  const selectedRows = new Set(selected.map(({ row }) => row));
  const continuation = windows.map((window) => nextState(window, selectedRows));
  return {
    items: selected.map(({ row }) => row.session),
    continuation: continuation.every((state) => state.exhausted) ? null : continuation,
  };
}

function selectConsumable(
  candidates: Array<{ window: PartitionWindow; row: RawRow }>,
  limit: number,
): Array<{ window: PartitionWindow; row: RawRow }> {
  const selected: Array<{ window: PartitionWindow; row: RawRow }> = [];
  const selectedRows = new Set<RawRow>();
  const remaining = [...candidates];
  while (selected.length < limit) {
    const index = remaining.findIndex(({ window, row }) => {
      const rowIndex = window.rows.indexOf(row);
      return window.rows
        .slice(0, rowIndex)
        .every((prior) => !prior.matching || selectedRows.has(prior));
    });
    if (index < 0) break;
    const candidate = remaining.splice(index, 1)[0]!;
    selected.push(candidate);
    selectedRows.add(candidate.row);
  }
  return selected;
}

function partitionPlan(query: SessionListPageQuery): Partition[] {
  if (query.repositoryIds?.length === 0) return [];
  const statusPartitions = statuses(query).flatMap((status) =>
    [...Array(query.shardCount).keys()].map((shard) => statusPartition(query, status, shard)),
  );
  if (query.repositoryId) {
    if (query.repositoryIds && !query.repositoryIds.includes(query.repositoryId)) return [];
    return query.sort.startsWith("priority_")
      ? repositoryPriorityPartitions(query, [query.repositoryId])
      : statusPartitions;
  }
  const repositories = query.repositoryIds?.toSorted();
  if (repositories === undefined) return statusPartitions;
  return query.sort.startsWith("priority_")
    ? repositoryPriorityPartitions(query, repositories)
    : statusPartitions;
}

function repositoryPriorityPartitions(
  query: SessionListPageQuery,
  repositoryIds: readonly string[],
): Partition[] {
  return statuses(query).flatMap((status) =>
    [...Array(query.shardCount).keys()].flatMap((shard) =>
      repositoryIds.map((repositoryId) => {
        const range = repositoryPriorityOrderRange(repositoryId);
        return {
          id: `repository-priority:${repositoryId}:${status}:${shard}`,
          indexName: SESSIONS_REPOSITORY_PRIORITY_ORDER_INDEX,
          keyName: "statusShard" as const,
          keyValue: statusShardAttr(status, shard),
          forward: query.sort === "priority_asc",
          sortKeyName: "repositoryPriorityOrder" as const,
          sortKeyRange: range,
          repositoryId,
        };
      }),
    ),
  );
}

function statusPartition(
  query: SessionListPageQuery,
  status: SessionStatus,
  shard: number,
): Partition {
  const priority = query.sort.startsWith("priority_");
  return {
    id: `status:${status}:${shard}`,
    indexName: priority ? SESSIONS_PRIORITY_ORDER_INDEX : SESSIONS_CREATED_ORDER_INDEX,
    keyName: "statusShard",
    keyValue: statusShardAttr(status, shard),
    forward: priority ? query.sort === "priority_asc" : query.sort !== "latest",
    sortKeyName: priority ? "priorityOrder" : "createdOrder",
  };
}

function statuses(query: SessionListPageQuery): readonly SessionStatus[] {
  return query.status ? [query.status] : SESSION_STATUSES;
}

function continuationForPlan(
  cursor: SessionCursorV2 | undefined,
  partitions: readonly Partition[],
): Map<string, PartitionState> {
  if (!cursor) {
    return new Map(
      partitions.map((partition) => [
        partition.id,
        { id: partition.id, checkpoint: null, exhausted: false },
      ]),
    );
  }
  if (
    cursor.partitions.length !== partitions.length ||
    cursor.partitions.some(
      (state, index) =>
        state.id !== partitions[index]?.id ||
        !validCheckpoint(state.checkpoint, partitions[index]!),
    )
  ) {
    throw new InvalidSessionCursorError();
  }
  return new Map(cursor.partitions.map((state) => [state.id, state]));
}

function validCheckpoint(
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
    (query.source === null || session.source === query.source) &&
    (query.concurrencyId === null || session.concurrencyId === query.concurrencyId) &&
    (query.scheduleId === null || session.scheduleId === query.scheduleId) &&
    (query.repositoryIds === null || query.repositoryIds.includes(session.repositoryId)) &&
    (!query.position || compareSessionToCursor(session, query.position, query.sort) > 0)
  );
}

async function queryPartitionWindow(
  ctx: PlaneStorageCtx,
  query: SessionListPageQuery,
  partition: Partition,
  previous: PartitionState,
): Promise<PartitionWindow> {
  const legacySortValue = query.position
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
      Limit: query.limit + 1,
      ...(previous.checkpoint ? { ExclusiveStartKey: previous.checkpoint } : {}),
    }),
  );
  const rows = (response.Items ?? []).map((item) => {
    const raw = item as Record<string, unknown>;
    const session = itemToSession(raw);
    return { item: raw, session, matching: matchesFilters(session, query) };
  });
  const nextKey = typedPageKey(
    response.LastEvaluatedKey as Record<string, unknown> | undefined,
    partition,
  );
  return { partition, previous, rows, nextKey, exhaustedRead: nextKey === undefined };
}

function nextState(window: PartitionWindow, selected: ReadonlySet<RawRow>): PartitionState {
  if (window.previous.exhausted) return window.previous;
  let lastConsumed = -1;
  for (let index = 0; index < window.rows.length; index++) {
    const row = window.rows[index]!;
    if (row.matching && !selected.has(row)) break;
    lastConsumed = index;
  }
  if (lastConsumed < 0) {
    // Empty Dynamo pages can still carry a continuation key: it is forward progress.
    if (window.rows.length === 0 && window.nextKey) {
      return { id: window.partition.id, checkpoint: window.nextKey, exhausted: false };
    }
    if (window.rows.length === 0 && window.exhaustedRead) {
      return { id: window.partition.id, checkpoint: window.previous.checkpoint, exhausted: true };
    }
    return { id: window.partition.id, checkpoint: window.previous.checkpoint, exhausted: false };
  }
  if (lastConsumed === window.rows.length - 1 && window.exhaustedRead) {
    return { id: window.partition.id, checkpoint: window.previous.checkpoint, exhausted: true };
  }
  return {
    id: window.partition.id,
    checkpoint: keyForRow(window.partition, window.rows[lastConsumed]!),
    exhausted: false,
  };
}

function keyForRow(partition: Partition, row: RawRow): SessionPartitionCheckpoint {
  const id = row.item.id;
  const range =
    row.item[partition.sortKeyName] ??
    (partition.sortKeyName === "createdOrder"
      ? createdOrderKey(row.session)
      : partition.sortKeyName === "priorityOrder"
        ? priorityOrderKey(row.session)
        : repositoryPriorityOrderKey(partition.repositoryId!, row.session));
  const hash = statusShardAttr(row.session.status, row.session.queueShard);
  if (typeof id !== "string" || typeof range !== "string" || typeof hash !== "string") {
    throw new Error("session query returned an invalid pagination key");
  }
  return { id, [partition.keyName]: hash, [partition.sortKeyName]: range };
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
