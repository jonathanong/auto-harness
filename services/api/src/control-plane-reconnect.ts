import type { ControlPlaneState } from "./control-plane-state.ts";
import { releaseWorktree } from "./control-plane-worktrees.ts";

export async function reconcileHostRunningSessions(
  state: ControlPlaneState,
  hostId: string,
  reported: readonly string[],
): Promise<string[]> {
  const running = new Set(reported);
  const connectionId = state.hostConnection.get(hostId);
  const requeued: string[] = [];
  if (state.storage && !connectionId) return requeued;
  const worktrees = state.storage
    ? await state.storage.listWorktreesByHost(hostId)
    : [...state.worktrees.values()].filter((worktree) => worktree.hostId === hostId);
  for (const worktree of worktrees) {
    if (worktree.status !== "busy" || !worktree.currentSessionId) continue;
    const session = state.storage
      ? await state.storage.getSession(worktree.currentSessionId)
      : state.sessions.get(worktree.currentSessionId);
    if (!session || session.status !== "running" || session.hostId !== hostId) continue;
    if (running.has(session.id)) {
      await confirmReportedSession(state, session, worktree, hostId, connectionId);
    } else if (!state.storage) {
      session.status = "queued";
      session.worktreeId = null;
      session.hostId = null;
      session.errorMessage = "daemon did not report session after reconnect; requeued";
      releaseWorktree(state, worktree.id);
      requeued.push(session.id);
    } else if (
      await state.storage.tryRequeueSession({
        sessionId: session.id,
        worktreeId: worktree.id,
        queueShard: session.queueShard,
        reason: "daemon did not report session after reconnect; requeued",
        forceOffline: false,
        expectedHostId: hostId,
        ...(session.assignmentConnectionId
          ? { expectedConnectionId: session.assignmentConnectionId }
          : {}),
        ...(connectionId ? { fence: { hostId, connectionId } } : {}),
      })
    ) {
      state.sessions.set(
        session.id,
        queued(session, "daemon did not report session after reconnect; requeued"),
      );
      state.worktrees.set(worktree.id, {
        ...worktree,
        status: "idle",
        currentSessionId: null,
        online: true,
      });
      requeued.push(session.id);
    }
  }
  return requeued;
}

export async function reclaimReconnectDeadlines(
  state: ControlPlaneState,
  nowMs: number,
): Promise<string[]> {
  const requeued: string[] = [];
  const sessions = state.storage
    ? await state.storage.listAllSessions()
    : [...state.sessions.values()];
  for (const session of sessions) {
    if (
      session.status !== "running" ||
      !session.reconnectDeadlineAt ||
      Date.parse(session.reconnectDeadlineAt) > nowMs ||
      !session.worktreeId
    )
      continue;
    const worktree = state.storage
      ? await state.storage.getWorktree(session.worktreeId)
      : state.worktrees.get(session.worktreeId);
    if (!worktree || !session.hostId) continue;
    const connectionId = state.storage
      ? await state.storage.getHostLock(session.hostId)
      : undefined;
    if (!state.storage) {
      state.sessions.set(
        session.id,
        queued(session, "daemon reconnect deadline exceeded; requeued"),
      );
      releaseWorktree(state, worktree.id);
      requeued.push(session.id);
    } else if (
      await state.storage.tryRequeueSession({
        sessionId: session.id,
        worktreeId: worktree.id,
        queueShard: session.queueShard,
        reason: "daemon reconnect deadline exceeded; requeued",
        forceOffline: true,
        expectedHostId: session.hostId,
        expectedReconnectDeadlineAt: session.reconnectDeadlineAt,
        ...(session.assignmentConnectionId
          ? { expectedConnectionId: session.assignmentConnectionId }
          : {}),
        ...(connectionId ? { fence: { hostId: session.hostId, connectionId } } : {}),
        ...(!connectionId ? { requireNoHostLock: session.hostId } : {}),
      })
    ) {
      state.sessions.set(
        session.id,
        queued(session, "daemon reconnect deadline exceeded; requeued"),
      );
      state.worktrees.set(worktree.id, {
        ...worktree,
        status: "idle",
        currentSessionId: null,
        online: false,
      });
      requeued.push(session.id);
    }
  }
  return requeued;
}

async function confirmReportedSession(
  state: ControlPlaneState,
  session: import("./db/types.ts").SessionRecord,
  worktree: import("./db/types.ts").WorktreeRecord,
  hostId: string,
  connectionId: string | undefined,
): Promise<void> {
  if (state.storage && !connectionId) return;
  const deadlineAt = session.reconnectDeadlineAt;
  const confirmed =
    !state.storage ||
    (await state.storage.confirmReconnect({
      sessionId: session.id,
      hostId,
      worktreeId: worktree.id,
      ...(deadlineAt ? { deadlineAt } : {}),
      connectionId: connectionId!,
    }));
  if (confirmed) {
    const { reconnectDeadlineAt: _, ...next } = session;
    state.sessions.set(session.id, next);
    state.worktrees.set(worktree.id, {
      ...worktree,
      online: true,
      ...(connectionId ? { connectionId } : {}),
    });
  }
}

function queued(session: import("./db/types.ts").SessionRecord, reason: string) {
  const { reconnectDeadlineAt: _, assignmentConnectionId: __, ...next } = session;
  return {
    ...next,
    status: "queued" as const,
    hostId: null,
    worktreeId: null,
    errorMessage: reason,
  };
}
