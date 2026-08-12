import type { ControlPlaneState } from "./control-plane-state.ts";
import { queueReconnectSession } from "./control-plane-reconnect-session.ts";
import { releaseWorktree } from "./control-plane-worktrees.ts";
import {
  confirmScheduledReconnect,
  reclaimScheduledReconnect,
  requeueOmittedScheduled,
  restoreScheduledReconnects,
  type ScheduledReconnectConfirmation,
} from "./control-plane-reconnect-scheduled.ts";
import { confirmReportedSession } from "./control-plane-reconnect-confirm.ts";
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
  const scheduledConfirmed: ScheduledReconnectConfirmation[] = [];
  if (state.storage && !connectionId) return requeued;

  try {
    for (const sessionId of running) {
      const session = state.storage
        ? await state.storage.getSession(sessionId)
        : state.sessions.get(sessionId);
      const worktree = session?.worktreeId
        ? state.storage
          ? await state.storage.getWorktree(session.worktreeId)
          : state.worktrees.get(session.worktreeId)
        : undefined;
      if (session?.mainCheckoutLease) {
        if (!(await confirmScheduledReconnect(state, session, hostId, connectionId))) {
          await restoreConfirmedSessions(state, hostId, connectionId, confirmed);
          await restoreScheduledReconnects(state, hostId, connectionId, scheduledConfirmed);
          return false;
        }
        scheduledConfirmed.push({ session });
        const { reconnectDeadlineAt: _, ...next } = session;
        state.sessions.set(session.id, { ...next, assignmentConnectionId: connectionId });
        continue;
      }
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
        await restoreScheduledReconnects(state, hostId, connectionId, scheduledConfirmed);
        return false;
      }
      if (!(await confirmReportedSession(state, session, worktree, hostId, connectionId))) {
        await restoreConfirmedSessions(state, hostId, connectionId, confirmed);
        await restoreScheduledReconnects(state, hostId, connectionId, scheduledConfirmed);
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
          nextConnectionId: connectionId!,
          ...(session.assignmentConnectionId
            ? { expectedConnectionId: session.assignmentConnectionId }
            : {}),
          fence: { hostId, connectionId: connectionId! },
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
    await requeueOmittedScheduled(state, hostId, running, requeued);
    return requeued;
  } catch (err) {
    await restoreConfirmedSessions(state, hostId, connectionId, confirmed);
    await restoreScheduledReconnects(state, hostId, connectionId, scheduledConfirmed);
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
    const reclaimableStatus =
      session.status === "running" ||
      (session.status === "cancelled" && session.mainCheckoutLease === true);
    if (
      !reclaimableStatus ||
      !session.reconnectDeadlineAt ||
      Date.parse(session.reconnectDeadlineAt) > nowMs ||
      (!session.worktreeId && !session.mainCheckoutLease)
    )
      continue;
    if (await reclaimScheduledReconnect(state, session, requeued)) continue;
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
