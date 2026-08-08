import { DEFAULT_QUEUE_SHARD_COUNT } from "@auto-harness/shared";

import type {
  SessionRecord,
  SessionRepository,
  WorktreeRecord,
  WorktreeRepository,
} from "../db/types.ts";

type SchedulerDeps = {
  sessions: SessionRepository;
  worktrees: WorktreeRepository;
  shardCount?: number;
  now?: () => string;
};

export function compareSessionsForQueue(a: SessionRecord, b: SessionRecord): number {
  if (b.priority !== a.priority) {
    return b.priority - a.priority;
  }
  return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}

export function compareWorktreesForRoundRobin(a: WorktreeRecord, b: WorktreeRecord): number {
  const aT = a.lastAssignedAt == null ? "" : a.lastAssignedAt;
  const bT = b.lastAssignedAt == null ? "" : b.lastAssignedAt;
  return aT.localeCompare(bT) || a.id.localeCompare(b.id);
}

/**
 * Assign queued sessions to idle worktrees with exclusive claim (Invariant 1)
 * and least-recently-assigned round-robin among candidates.
 */
export class Scheduler {
  private readonly deps: SchedulerDeps;
  private readonly shardCount: number;
  private readonly now: () => string;

  constructor(deps: SchedulerDeps) {
    this.deps = deps;
    this.shardCount = deps.shardCount ?? DEFAULT_QUEUE_SHARD_COUNT;
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  async assignQueued(): Promise<Array<{ session: SessionRecord; worktree: WorktreeRecord }>> {
    const assigned: Array<{
      session: SessionRecord;
      worktree: WorktreeRecord;
    }> = [];

    for (let shard = 0; shard < this.shardCount; shard++) {
      const queued = await this.deps.sessions.listByStatus("queued", shard);
      queued.sort(compareSessionsForQueue);

      for (const session of queued) {
        if (session.hostId && session.worktreeId) {
          continue;
        }
        const idle = await this.deps.worktrees.listIdleForRepo(session.repositoryId);
        const candidates = idle.filter((w) =>
          session.requiredLabels.every((l) => w.labels.includes(l)),
        );
        candidates.sort(compareWorktreesForRoundRobin);

        for (const candidate of candidates) {
          const won = await this.deps.worktrees.tryClaim({
            worktreeId: candidate.id,
            sessionId: session.id,
            now: this.now(),
          });
          if (!won) {
            continue;
          }
          session.status = "running";
          session.worktreeId = candidate.id;
          session.hostId = candidate.hostId;
          await this.deps.sessions.updateStatus(session.id, "running");
          assigned.push({ session, worktree: candidate });
          break;
        }
      }
    }

    return assigned;
  }
}
