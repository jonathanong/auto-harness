import type { SessionRecord, WorktreeRecord } from "./db/types.ts";

export function compareSessionsForQueue(
  a: Pick<SessionRecord, "id" | "priority" | "createdAt">,
  b: Pick<SessionRecord, "id" | "priority" | "createdAt">,
): number {
  if (b.priority !== a.priority) {
    return b.priority - a.priority;
  }
  return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}

export function compareWorktreesForRoundRobin(
  a: Pick<WorktreeRecord, "id" | "lastAssignedAt">,
  b: Pick<WorktreeRecord, "id" | "lastAssignedAt">,
): number {
  const aT = a.lastAssignedAt == null ? "" : a.lastAssignedAt;
  const bT = b.lastAssignedAt == null ? "" : b.lastAssignedAt;
  return aT.localeCompare(bT) || a.id.localeCompare(b.id);
}
