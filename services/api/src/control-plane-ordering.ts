import type { SessionRecord, WorktreeRecord } from "./db/types.ts";

/** GSI that stores `compareSessionsForQueue` as an ascending sort key. */
export const SESSIONS_QUEUE_ORDER_INDEX = "statusShard-queueOrder";
export const SESSIONS_STATUS_CREATED_INDEX = "statusShard-createdAt";

/** Matches `validateCreateSessionInput` so inverted priorities stay non-negative. */
export const QUEUE_ORDER_PRIORITY_OFFSET = 10_000;
/** Micro-priority scale so fractional API priorities keep numeric order as strings. */
const QUEUE_ORDER_PRIORITY_SCALE = 1_000_000;
const QUEUE_ORDER_KEY_WIDTH = 12;

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
  const scaled = Math.round(inverted * QUEUE_ORDER_PRIORITY_SCALE);
  return `${String(scaled).padStart(QUEUE_ORDER_KEY_WIDTH, "0")}#${session.createdAt}#${session.id}`;
}

/** Always produce a GSI key for a requeue write, even if a pre-read omitted fields. */
export function queueOrderKeyForWrite(
  session: { id?: unknown; priority?: unknown; createdAt?: unknown } | null | undefined,
  fallbackId: string,
): string {
  return queueOrderKey({
    id: typeof session?.id === "string" && session.id.length > 0 ? session.id : fallbackId,
    priority: typeof session?.priority === "number" ? session.priority : 0,
    createdAt: typeof session?.createdAt === "string" ? session.createdAt : "",
  });
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
