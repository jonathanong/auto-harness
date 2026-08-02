import type { SessionStatus } from "@auto-harness/shared";

import type {
  SessionRecord,
  SessionRepository,
  WorktreeRecord,
  WorktreeRepository,
} from "./types.js";

export class MemorySessionRepository implements SessionRepository {
  private readonly sessions = new Map<string, SessionRecord>();

  async putNew(session: SessionRecord): Promise<void> {
    if (this.sessions.has(session.id)) {
      throw new Error(`session already exists: ${session.id}`);
    }
    this.sessions.set(session.id, { ...session });
  }

  async get(id: string): Promise<SessionRecord | null> {
    const s = this.sessions.get(id);
    return s ? { ...s } : null;
  }

  async listByStatus(status: SessionStatus, shard: number): Promise<SessionRecord[]> {
    return [...this.sessions.values()]
      .filter((s) => s.status === status && s.queueShard === shard)
      .map((s) => ({ ...s }));
  }

  async updateStatus(id: string, status: SessionStatus): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) {
      throw new Error(`session not found: ${id}`);
    }
    s.status = status;
  }
}

export class MemoryWorktreeRepository implements WorktreeRepository {
  private readonly worktrees = new Map<string, WorktreeRecord>();

  seed(record: WorktreeRecord): void {
    this.worktrees.set(record.id, { ...record });
  }

  async tryClaim(opts: { worktreeId: string; sessionId: string; now: string }): Promise<boolean> {
    const wt = this.worktrees.get(opts.worktreeId);
    if (!wt || wt.status !== "idle" || !wt.online) {
      return false;
    }
    wt.status = "busy";
    wt.currentSessionId = opts.sessionId;
    wt.lastAssignedAt = opts.now;
    return true;
  }

  async release(worktreeId: string): Promise<void> {
    const wt = this.worktrees.get(worktreeId);
    if (!wt) {
      return;
    }
    wt.status = "idle";
    wt.currentSessionId = null;
  }

  async listIdleForRepo(repositoryId: string): Promise<WorktreeRecord[]> {
    return [...this.worktrees.values()]
      .filter((w) => w.repositoryId === repositoryId && w.status === "idle" && w.online)
      .map((w) => ({ ...w }));
  }
}
