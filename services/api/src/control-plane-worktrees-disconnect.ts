import type { ControlPlaneState } from "./control-plane-state.ts";

/** Durable host-disconnect recovery. Each session/worktree pair is released
 * atomically; a late duplicate disconnect simply observes the already-
 * requeued state and becomes a no-op. */
export async function offlineHostAndRequeueDurableImpl(
  state: ControlPlaneState,
  hostId: string,
  connectionId: string,
  reason: string,
  localFallback: (state: ControlPlaneState, hostId: string, reason: string) => string[],
): Promise<string[]> {
  if (!state.storage) return localFallback(state, hostId, reason);
  const requeued: string[] = [];
  const durableWorktrees = await state.storage.listWorktreesByHost(hostId);
  for (const wt of durableWorktrees) {
    if (wt.connectionId && wt.connectionId !== connectionId) continue;
    if (wt.status !== "busy" || !wt.currentSessionId) {
      const next = { ...wt, online: false };
      if (
        await state.storage.setWorktreeOnlineFenced(wt.id, connectionId, false, {
          hostId,
          connectionId,
        })
      ) {
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
      if (
        await state.storage.setWorktreeOnlineFenced(wt.id, connectionId, false, {
          hostId,
          connectionId,
        })
      ) {
        state.worktrees.set(wt.id, next);
      }
      continue;
    }
    if (session.status === "cancelled") {
      const released = await state.storage.releaseCancelledSessionWorktree({
        sessionId,
        worktreeId: wt.id,
        online: false,
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
    if (session.status !== "running") continue;
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
      if (latest) state.worktrees.set(wt.id, latest);
      const latestSession = await state.storage.getSession(sessionId);
      if (latestSession) state.sessions.set(sessionId, latestSession);
    }
  }
  return requeued;
}
