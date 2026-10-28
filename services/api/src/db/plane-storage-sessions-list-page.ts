/* eslint-disable max-lines -- bounded partition planning and cursor advancement are coupled. */
import type { SessionStatus } from "@auto-harness/shared";

import {
  createdOrderKey,
  priorityOrderKey,
  repositoryPriorityOrderKey,
} from "../control-plane-ordering.ts";
import type {
  CursorPosition,
  SessionCursorV2,
  SessionListSort,
  SessionPartitionCheckpoint,
} from "../control-plane-session-cursor.ts";
import { InvalidSessionCursorError } from "../control-plane-session-cursor.ts";
import { compareSessions } from "../control-plane-session-order.ts";
import { legacyPartitionPlan, singlePartition } from "./plane-storage-sessions-list-plan.ts";
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
  const partitions = await planForRequest(ctx, query);
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
  const startedAt = Date.now();
  const roundMs: number[] = [];
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
  roundMs.push(Date.now() - startedAt);
  let selected = selectPage(windows, query);
  while (selected.length < query.limit) {
    const refill = refillableWindows(windows, query);
    if (refill.length === 0) break;
    const roundStartedAt = Date.now();
    await Promise.all(refill.map((window) => extendPartitionWindow(ctx, query, window)));
    roundMs.push(Date.now() - roundStartedAt);
    selected = selectPage(windows, query);
  }
  const selectedRows = new Set(selected.map(({ row }) => row));
  const continuation = windows.map((window) => nextState(window, selectedRows));
  logSlowListRead(query, windows, roundMs, Date.now() - startedAt, selected.length);
  return {
    items: selected.map(({ row }) => row.session),
    continuation: continuation.every((state) => state.exhausted) ? null : continuation,
  };
}

/** Reads slower than this log their shape, to locate list latency in production. */
const SLOW_LIST_READ_MS = 500;

function logSlowListRead(
  query: SessionListPageQuery,
  windows: readonly PartitionWindow[],
  roundMs: readonly number[],
  durationMs: number,
  items: number,
): void {
  if (durationMs < SLOW_LIST_READ_MS) return;
  console.log(
    JSON.stringify({
      msg: "slow session list read",
      durationMs,
      roundMs,
      limit: query.limit,
      sort: query.sort,
      filtered:
        query.status !== null ||
        query.repositoryId !== null ||
        query.repositoryIds !== null ||
        query.hostId !== null ||
        Boolean(query.worktreeId) ||
        query.source !== null ||
        query.concurrencyId !== null ||
        query.scheduleId !== null,
      partitions: windows.length,
      rowsRead: windows.reduce((sum, window) => sum + window.rows.length, 0),
      rowsRequested: windows.reduce((sum, window) => sum + window.requested, 0),
      items,
    }),
  );
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

/**
 * One-partition plans are used only once the readiness marker proves the indexes. A cursor
 * names the plan that minted it, so it also decides across a deploy: a legacy status/shard
 * cursor keeps its legacy plan, and a one-partition cursor proves the indexes are ready even
 * when this instance's cached readiness is stale.
 */
async function planForRequest(
  ctx: PlaneStorageCtx,
  query: SessionListPageQuery,
): Promise<Partition[]> {
  const legacy = legacyPartitionPlan(query);
  const single = singlePartition(query);
  if (legacy.length === 0 || !single) return legacy;
  const cursor = query.continuation;
  if (cursor && planMatches(cursor, [single])) {
    ctx.sessionListIndexes?.markReady();
    return [single];
  }
  if (cursor) return legacy;
  return (await ctx.sessionListIndexes?.ready()) ? [single] : legacy;
}

function planMatches(cursor: SessionCursorV2, partitions: readonly Partition[]): boolean {
  return (
    cursor.partitions.length === partitions.length &&
    cursor.partitions.every((state, index) => state.id === partitions[index]?.id)
  );
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
  const hash = partition.keyValue;
  if (typeof id !== "string" || typeof range !== "string" || typeof hash !== "string") {
    throw new Error("session query returned an invalid pagination key");
  }
  return { id, [partition.keyName]: hash, [partition.sortKeyName]: range };
}
