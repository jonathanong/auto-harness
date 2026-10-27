/* eslint-disable max-lines -- bounded partition planning and cursor advancement are coupled. */
import { SESSION_STATUSES, type SessionStatus } from "@auto-harness/shared";

import {
  SESSIONS_CREATED_ORDER_INDEX,
  createdOrderKey,
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
import { compareSessions } from "../control-plane-session-order.ts";
import { statusShardAttr } from "./dynamo.ts";
import {
  extendPartitionWindow,
  initialWindowLimit,
  openPartitionWindow,
  refillableWindows,
  validCheckpoint,
  type Partition,
  type PartitionState,
  type PartitionWindow,
  type RawRow,
} from "./plane-storage-sessions-list-window.ts";
import type { PlaneStorageCtx } from "./plane-storage-types.ts";
import type { SessionRecord } from "./types.ts";

export type SessionListPageQuery = {
  limit: number;
  sort: SessionListSort;
  shardCount: number;
  status: SessionStatus | null;
  repositoryId: string | null;
  repositoryIds: string[] | null;
  hostId: string | null;
  worktreeId?: string | null;
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

/**
 * Query each selected partition for a small window, then refill only the partitions
 * that hold the page back. Never scans; each partition reads at most `limit + 1` rows
 * per page (see `extendPartitionWindow`), so a sparse filter ends with a short page
 * and a continuation rather than a loop.
 */
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
  const initialLimit = initialWindowLimit(query.limit, partitions.length);
  const windows = await Promise.all(
    partitions.map(async (partition): Promise<PartitionWindow> => {
      const stored = states.get(partition.id)!;
      const previous =
        revisitExhausted && stored.exhausted
          ? { id: stored.id, checkpoint: null, exhausted: false }
          : stored;
      return previous.exhausted
        ? { partition, previous, rows: [], nextKey: undefined, exhaustedRead: true, requested: 0 }
        : openPartitionWindow(ctx, query, partition, previous, initialLimit);
    }),
  );
  let selected = selectPage(windows, query);
  while (selected.length < query.limit) {
    const refill = refillableWindows(windows, query);
    if (refill.length === 0) break;
    await Promise.all(refill.map((window) => extendPartitionWindow(ctx, query, window)));
    selected = selectPage(windows, query);
  }
  const selectedRows = new Set(selected.map(({ row }) => row));
  const continuation = windows.map((window) => nextState(window, selectedRows));
  return {
    items: selected.map(({ row }) => row.session),
    continuation: continuation.every((state) => state.exhausted) ? null : continuation,
  };
}

function selectPage(
  windows: readonly PartitionWindow[],
  query: SessionListPageQuery,
): Array<{ window: PartitionWindow; row: RawRow }> {
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
  return selectConsumable(safe, query.limit);
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
  // A large scope must not turn into one cursor checkpoint per repository.
  // Scope filtering happens after the fixed status/shard index reads instead.
  return statusPartitions;
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
