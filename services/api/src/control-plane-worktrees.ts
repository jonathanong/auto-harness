import type { WorktreeRecord } from "./db/types.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";
import { persistWorktree, queueWrite } from "./control-plane-state.ts";

export function seedWorktree(state: ControlPlaneState, record: WorktreeRecord): void {
  persistWorktree(state, { ...record });
}

export function listWorktrees(state: ControlPlaneState): WorktreeRecord[] {
  return [...state.worktrees.values()].map((w) => ({ ...w }));
}

export function getWorktree(state: ControlPlaneState, id: string): WorktreeRecord | null {
  const w = state.worktrees.get(id);
  return w ? { ...w } : null;
}

export function tryClaimWorktree(
  state: ControlPlaneState,
  worktreeId: string,
  sessionId: string,
  now: string,
): boolean {
  const wt = state.worktrees.get(worktreeId);
  if (!wt || wt.status !== "idle" || !wt.online) {
    return false;
  }
  wt.status = "busy";
  wt.currentSessionId = sessionId;
  wt.lastAssignedAt = now;
  // Durable write (DynamoDB Local / AWS). Process-local exclusive claim is the Map above;
  // conditional UpdateItem is available on storage for multi-writer deployments.
  persistWorktree(state, { ...wt });
  if (state.storage) {
    queueWrite(
      state,
      state.storage.tryClaimWorktree({ worktreeId, sessionId, now }).then(() => {
        /* claim written */
      }),
    );
  }
  return true;
}

export function releaseWorktree(state: ControlPlaneState, worktreeId: string): void {
  const wt = state.worktrees.get(worktreeId);
  if (!wt) {
    return;
  }
  wt.status = "idle";
  wt.currentSessionId = null;
  // Drain / disconnect are sticky: released worktrees must not become assignable.
  if (state.drainingHosts.has(wt.hostId) || state.disconnectedHosts.has(wt.hostId)) {
    wt.online = false;
  }
  persistWorktree(state, { ...wt });
}

/** Offline every worktree for hostId; requeue any running sessions. */
export function offlineHostAndRequeue(
  state: ControlPlaneState,
  hostId: string,
  reason: string,
): string[] {
  const requeued: string[] = [];
  for (const wt of state.worktrees.values()) {
    if (wt.hostId !== hostId) {
      continue;
    }
    wt.online = false;
    if (wt.status === "busy") {
      const sid = wt.currentSessionId;
      releaseWorktree(state, wt.id);
      wt.online = false;
      if (sid) {
        const session = state.sessions.get(sid);
        if (session?.status === "running") {
          session.status = "queued";
          session.worktreeId = null;
          session.hostId = null;
          session.errorMessage = reason;
          state.pendingAcks.delete(sid);
          requeued.push(sid);
        }
      }
    }
  }
  return requeued;
}

/** Durable host disconnect recovery. Each session/worktree pair is released
 * atomically; a late duplicate disconnect simply observes the already-requeued
 * state and becomes a no-op. */
export async function offlineHostAndRequeueDurable(
  state: ControlPlaneState,
  hostId: string,
  reason: string,
): Promise<string[]> {
  if (!state.storage) {
    return offlineHostAndRequeue(state, hostId, reason);
  }
  const requeued: string[] = [];
  for (const wt of state.worktrees.values()) {
    if (wt.hostId !== hostId) {
      continue;
    }
    if (wt.status !== "busy" || !wt.currentSessionId) {
      const next = { ...wt, online: false };
      await state.storage.setWorktreeOnline(wt.id, false);
      state.worktrees.set(wt.id, next);
      continue;
    }
    const sessionId = wt.currentSessionId;
    // A process can hold a stale worktree cache after another instance creates
    // a session. Read the durable row before calculating the GSI shard instead
    // of fabricating shard zero and corrupting the status index.
    const session = state.sessions.get(sessionId) ?? (await state.storage.getSession(sessionId));
    if (!session) {
      const next = { ...wt, online: false };
      await state.storage.setWorktreeOnline(wt.id, false);
      state.worktrees.set(wt.id, next);
      continue;
    }
    const won = await state.storage.tryRequeueSession({
      sessionId,
      worktreeId: wt.id,
      queueShard: session.queueShard,
      reason,
      forceOffline: true,
    });
    if (won) {
      state.sessions.set(sessionId, {
        ...session,
        status: "queued",
        worktreeId: null,
        hostId: null,
        errorMessage: reason,
      });
      state.pendingAcks.delete(sessionId);
      state.worktrees.set(wt.id, {
        ...wt,
        status: "idle",
        currentSessionId: null,
        online: false,
      });
      requeued.push(sessionId);
    } else {
      // A terminal update may have won the race. Refreshing the local row
      // prevents this process from retrying the same stale ownership forever.
      const latest = await state.storage.getWorktree(wt.id);
      if (latest) {
        state.worktrees.set(wt.id, latest);
      }
      const latestSession = await state.storage.getSession(sessionId);
      if (latestSession) {
        state.sessions.set(sessionId, latestSession);
      }
    }
  }
  return requeued;
}
