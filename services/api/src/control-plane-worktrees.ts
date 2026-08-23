import type { WorktreeRecord } from "./db/types.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";
import { persistWorktree, queueWrite } from "./control-plane-state.ts";
import { offlineHostAndRequeueDurableImpl } from "./control-plane-worktrees-disconnect.ts";
import { releaseScheduledLeaseLocal } from "./control-plane-scheduled-assign.ts";
import { queueReconnectSession } from "./control-plane-reconnect-session.ts";
import { releaseWorktree } from "./control-plane-worktree-release.ts";

export { releaseWorktree } from "./control-plane-worktree-release.ts";

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
    queueWrite(state, (storage) =>
      storage!.tryClaimWorktree({ worktreeId, sessionId, now }).then(() => {
        /* claim written */
      }),
    );
  }
  return true;
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
  for (const session of state.sessions.values()) {
    if (session.hostId !== hostId || !session.mainCheckoutLease || session.status !== "running")
      continue;
    if (!session.ackReceivedAt) {
      releaseScheduledLeaseLocal(state, session);
      state.sessions.set(session.id, queueReconnectSession(session, reason));
      state.pendingAcks.delete(session.id);
      requeued.push(session.id);
    } else {
      session.reconnectDeadlineAt = new Date(
        Date.parse(state.now()) + state.reconnectGraceMs,
      ).toISOString();
    }
  }
  return requeued;
}

export async function offlineHostAndRequeueDurable(
  state: ControlPlaneState,
  hostId: string,
  connectionId: string,
  reason: string,
): Promise<string[]> {
  return offlineHostAndRequeueDurableImpl(
    state,
    hostId,
    connectionId,
    reason,
    offlineHostAndRequeue,
  );
}
