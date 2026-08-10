import type { ControlPlaneState } from "./control-plane-state.ts";
import { queueReconnectSession } from "./control-plane-reconnect-session.ts";
import { releaseWorktree } from "./control-plane-worktrees.ts";
import {
  restoreConfirmedSessions,
  type ReconnectConfirmation,
} from "./control-plane-reconnect-rollback.ts";

export async function reconcileHostRunningSessions(
  state: ControlPlaneState,
  hostId: string,
  reported: readonly string[],
): Promise<string[] | false> {
  const running = new Set(reported);
  const connectionId = state.hostConnection.get(hostId);
  const requeued: string[] = [];
  const confirmed: ReconnectConfirmation[] = [];
  if (state.storage && !connectionId) return requeued;

  try {
    // Treat every daemon-reported session as a claim that must be confirmed
    // against the durable state *after* this registration acquired its lease.
    // A grace sweep can win between pre-registration validation and this point;
    // accepting the registration in that case would open a new socket barrier
    // for a process whose work was already safely requeued.
    for (const sessionId of running) {
      const session = state.storage
        ? await state.storage.getSession(sessionId)
        : state.sessions.get(sessionId);
      const worktree = session?.worktreeId
        ? state.storage
          ? await state.storage.getWorktree(session.worktreeId)
          : state.worktrees.get(session.worktreeId)
        : undefined;
      if (
        !session ||
        session.status !== "running" ||
        !session.ackReceivedAt ||
        session.hostId !== hostId ||
        !session.worktreeId ||
        !worktree ||
        worktree.hostId !== hostId ||
        worktree.currentSessionId !== session.id
      ) {
        await restoreConfirmedSessions(state, hostId, connectionId, confirmed);
        return false;
      }
      if (!(await confirmReportedSession(state, session, worktree, hostId, connectionId))) {
        await restoreConfirmedSessions(state, hostId, connectionId, confirmed);
        return false;
      }
      confirmed.push({ session, worktree });
    }
    const worktrees = state.storage
      ? await state.storage.listWorktreesByHost(hostId)
      : [...state.worktrees.values()].filter((worktree) => worktree.hostId === hostId);
    for (const worktree of worktrees) {
      if (worktree.status !== "busy" || !worktree.currentSessionId) continue;
      const session = state.storage
        ? await state.storage.getSession(worktree.currentSessionId)
        : state.sessions.get(worktree.currentSessionId);
      if (!session || session.status !== "running" || session.hostId !== hostId) continue;
      if (running.has(session.id)) continue;
      if (!state.storage) {
        state.sessions.set(
          session.id,
          queueReconnectSession(session, "daemon did not report session after reconnect; requeued"),
        );
        releaseWorktree(state, worktree.id);
        state.pendingAcks.delete(session.id);
        requeued.push(session.id);
      } else if (
        await state.storage.tryRequeueSession({
          sessionId: session.id,
          worktreeId: worktree.id,
          attemptId: session.attemptId!,
          queueShard: session.queueShard,
          reason: "daemon did not report session after reconnect; requeued",
          forceOffline: false,
          expectedHostId: hostId,
          ...(connectionId ? { nextConnectionId: connectionId } : {}),
          ...(session.assignmentConnectionId
            ? { expectedConnectionId: session.assignmentConnectionId }
            : {}),
          ...(connectionId ? { fence: { hostId, connectionId } } : {}),
        })
      ) {
        state.sessions.set(
          session.id,
          queueReconnectSession(session, "daemon did not report session after reconnect; requeued"),
        );
        state.worktrees.set(worktree.id, {
          ...worktree,
          status: "idle",
          currentSessionId: null,
          online: true,
        });
        state.pendingAcks.delete(session.id);
        requeued.push(session.id);
      }
    }
    return requeued;
  } catch (err) {
    // A later durable read or write can fail after earlier reports were
    // confirmed. Restore those reports before registration drops its lease.
    await restoreConfirmedSessions(state, hostId, connectionId, confirmed);
    throw err;
  }
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
        queueReconnectSession(session, "daemon reconnect deadline exceeded; requeued"),
      );
      releaseWorktree(state, worktree.id);
      state.pendingAcks.delete(session.id);
      requeued.push(session.id);
    } else if (
      await state.storage.tryRequeueSession({
        sessionId: session.id,
        worktreeId: worktree.id,
        attemptId: session.attemptId!,
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
        queueReconnectSession(session, "daemon reconnect deadline exceeded; requeued"),
      );
      state.worktrees.set(worktree.id, {
        ...worktree,
        status: "idle",
        currentSessionId: null,
        online: false,
      });
      state.pendingAcks.delete(session.id);
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
): Promise<boolean> {
  if (state.storage && !connectionId) return false;
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
  return confirmed;
}
