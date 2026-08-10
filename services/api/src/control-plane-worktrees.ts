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
    if (wt.hostId !== hostId) continue;
    wt.online = false;
    if (wt.status === "busy") {
      const sid = wt.currentSessionId;
      if (sid) {
        const session = state.sessions.get(sid);
        if (session?.status === "running" && !session.ackReceivedAt) {
          releaseWorktree(state, wt.id);
          wt.online = false;
          session.status = "queued";
          session.worktreeId = null;
          session.hostId = null;
          session.errorMessage = reason;
          state.pendingAcks.delete(sid);
          requeued.push(sid);
        } else if (session?.status === "running") {
          session.reconnectDeadlineAt = new Date(
            Date.parse(state.now()) + state.reconnectGraceMs,
          ).toISOString();
          persistWorktree(state, { ...wt, online: false });
        }
      } else {
        persistWorktree(state, { ...wt, online: false });
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
  connectionId: string,
  reason: string,
): Promise<string[]> {
  if (!state.storage) {
    return offlineHostAndRequeue(state, hostId, reason);
  }
  const requeued: string[] = [];
  const durableWorktrees = await state.storage.listWorktreesByHost(hostId);
  for (const wt of durableWorktrees) {
    if (wt.connectionId && wt.connectionId !== connectionId) continue;
    if (wt.status !== "busy" || !wt.currentSessionId) {
      const next = { ...wt, online: false };
      if (await state.storage.setWorktreeOnlineFenced(wt.id, connectionId, false)) {
        state.worktrees.set(wt.id, next);
      }
      continue;
    }
    const sessionId = wt.currentSessionId;
    // A process can hold a stale worktree cache after another instance creates
    // a session. Read the durable row before calculating the GSI shard instead
    // of fabricating shard zero and corrupting the status index.
    const session = await state.storage.getSession(sessionId);
    if (!session) {
      const next = { ...wt, online: false };
      if (await state.storage.setWorktreeOnlineFenced(wt.id, connectionId, false)) {
        state.worktrees.set(wt.id, next);
      }
      continue;
    }
    if (session.status === "cancelled") {
      const released = await state.storage.releaseCancelledSessionWorktree({
        sessionId,
        worktreeId: wt.id,
        fence: { hostId, connectionId },
      });
      if (released) {
        state.sessions.set(sessionId, { ...session, hostId: null, worktreeId: null });
        state.worktrees.set(wt.id, {
          ...wt,
          status: "idle",
          currentSessionId: null,
          online: false,
        });
      }
      continue;
    }
    if (session.status !== "running") {
      continue;
    }
    if (session.ackReceivedAt) {
      const nextSession = {
        ...session,
        reconnectDeadlineAt: new Date(
          Date.parse(state.now()) + state.reconnectGraceMs,
        ).toISOString(),
      };
      const marked = await state.storage.markReconnectPending({
        sessionId,
        hostId,
        worktreeId: wt.id,
        deadlineAt: nextSession.reconnectDeadlineAt,
        connectionId,
      });
      if (marked) {
        state.sessions.set(sessionId, nextSession);
        state.worktrees.set(wt.id, { ...wt, online: false });
      }
      continue;
    }
    const won = await state.storage.tryRequeueSession({
      sessionId,
      worktreeId: wt.id,
      queueShard: session.queueShard,
      reason,
      forceOffline: true,
      expectedConnectionId: connectionId,
      fence: { hostId, connectionId },
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
