import type { SessionRecord, WorktreeRecord } from "./db/types.ts";

/** GSI that stores `compareSessionsForQueue` as an ascending sort key. */
export const SESSIONS_QUEUE_ORDER_INDEX = "statusShard-queueOrder";
export const SESSIONS_STATUS_CREATED_INDEX = "statusShard-createdAt";

/** Matches `validateCreateSessionInput` so inverted priorities stay non-negative. */
export const QUEUE_ORDER_PRIORITY_OFFSET = 10_000;

export function compareSessionsForQueue(
  a: Pick<SessionRecord, "id" | "priority" | "createdAt">,
  b: Pick<SessionRecord, "id" | "priority" | "createdAt">,
): number {
  if (b.priority !== a.priority) {
    return b.priority - a.priority;
  }
  return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}

/** Encode priority/FIFO/id so DynamoDB ascending order matches `compareSessionsForQueue`. */
export function queueOrderKey(
  session: Pick<SessionRecord, "id" | "priority" | "createdAt">,
): string {
  const inverted = Math.min(
    QUEUE_ORDER_PRIORITY_OFFSET * 2,
    Math.max(0, QUEUE_ORDER_PRIORITY_OFFSET - session.priority),
  );
  return `${String(inverted).padStart(5, "0")}#${session.createdAt}#${session.id}`;
}

/** Consume already-sorted shard heads in global priority/FIFO order. */
export function mergeQueuedShardHeads<
  T extends Pick<SessionRecord, "id" | "priority" | "createdAt">,
>(shards: readonly T[][]): T[] {
  const indexes = shards.map(() => 0);
  const merged: T[] = [];
  for (;;) {
    let winner = -1;
    for (let shard = 0; shard < shards.length; shard++) {
      const candidate = shards[shard]![indexes[shard]!];
      if (!candidate) continue;
      if (
        winner < 0 ||
        compareSessionsForQueue(candidate, shards[winner]![indexes[winner]!]!) < 0
      ) {
        winner = shard;
      }
    }
    if (winner < 0) return merged;
    merged.push(shards[winner]![indexes[winner]!]!);
    indexes[winner]! += 1;
  }
}

function queuedSessionsByShard(
  sessions: Iterable<SessionRecord>,
  shardCount: number,
  type: "prompt" | "scheduled",
): SessionRecord[][] {
  const shards = Array.from({ length: shardCount }, () => [] as SessionRecord[]);
  for (const session of sessions) {
    if (session.status !== "queued") continue;
    if (type === "scheduled" ? session.type !== "scheduled" : session.type === "scheduled") {
      continue;
    }
    const shard = shards[session.queueShard];
    if (!shard) continue;
    shard.push(session);
  }
  for (const shard of shards) shard.sort(compareSessionsForQueue);
  return shards;
}

export function orderedQueuedSessions(
  sessions: Iterable<SessionRecord>,
  shardCount: number,
  type: "prompt" | "scheduled",
): SessionRecord[] {
  return mergeQueuedShardHeads(queuedSessionsByShard(sessions, shardCount, type));
}

export function compareWorktreesForRoundRobin(
  a: Pick<WorktreeRecord, "id" | "lastAssignedAt">,
  b: Pick<WorktreeRecord, "id" | "lastAssignedAt">,
): number {
  const aT = a.lastAssignedAt == null ? "" : a.lastAssignedAt;
  const bT = b.lastAssignedAt == null ? "" : b.lastAssignedAt;
  return aT.localeCompare(bT) || a.id.localeCompare(b.id);
}
