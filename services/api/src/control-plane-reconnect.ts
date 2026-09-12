/* eslint-disable max-lines -- attempt-fenced reconnect claims stay with this table. */
import type { HostRunningAttempt } from "@auto-harness/shared";
import type { ControlPlaneState } from "./control-plane-state.ts";
import { releaseWorktree } from "./control-plane-worktrees.ts";
import { reconcileHostOwnedSessions } from "./control-plane-reconnect-omitted.ts";
import { reclaimScheduledReconnect } from "./control-plane-reconnect-scheduled.ts";
import {
  confirmScheduledReconnect,
  restoreScheduledReconnects,
  type ScheduledReconnectConfirmation,
} from "./control-plane-reconnect-scheduled-confirm.ts";
import {
  confirmReportedSession,
  ignoreStaleReconnectClaim,
} from "./control-plane-reconnect-confirm.ts";
import {
  providerAccountLeaseWriteOpts,
  releaseProviderAccountLease,
} from "./control-plane-provider-account-leases.ts";
import { releaseLegacyHostAssignmentAfterDurableTransition } from "./control-plane-legacy-host-assignment.ts";
import {
  restoreConfirmedSessions,
  type ReconnectConfirmation,
} from "./control-plane-reconnect-rollback.ts";
import {
  canRetryHostLoss,
  finishHostLostSession,
  hostLostTerminalHookHandoff,
  HOST_LOSS_RETRY_REASON,
  HOST_LOSS_TERMINAL_REASON,
  queueHostLossRetry,
} from "./control-plane-infrastructure-retry.ts";
import { expireTerminalHookHandoffIfNeeded } from "./control-plane-terminal-hook-handoff.ts";

export async function reconcileHostRunningSessions(
  state: ControlPlaneState,
  hostId: string,
  reported: readonly string[],
  reportedAttempts: readonly HostRunningAttempt[] = [],
): Promise<string[] | false> {
  const claimedAttempts = new Map(reportedAttempts.map((item) => [item.sessionId, item.attemptId]));
  const running = new Set(reported);
  const connectionId = state.hostConnection.get(hostId);
  const requeued: string[] = [];
  const confirmed: ReconnectConfirmation[] = [];
  const scheduledConfirmed: ScheduledReconnectConfirmation[] = [];
  if (state.storage && !connectionId) return requeued;

  try {
    for (const sessionId of reported) {
      const session = state.storage
        ? await state.storage.getSession(sessionId)
        : state.sessions.get(sessionId);
      if (ignoreStaleReconnectClaim(state, session, claimedAttempts.get(sessionId))) {
        running.delete(sessionId);
        continue;
      }
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
    requeued.push(
      ...(await reconcileHostOwnedSessions(
        state,
        hostId,
        connectionId,
        running,
        "daemon did not report session after reconnect; requeued",
      )),
    );
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
    if (await expireTerminalHookHandoffIfNeeded(state, session, nowMs)) continue;
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
    // The guard above allows a mainCheckoutLease session with no worktreeId through; the
    // lookup below correctly finds nothing for it and the !worktree check skips it, same
    // as before this session's worktreeId ever went missing.
    const worktreeId = session.worktreeId ?? "";
    const worktree = state.storage
      ? await state.storage.getWorktree(worktreeId)
      : state.worktrees.get(worktreeId);
    if (!worktree || !session.hostId) continue;
    const connectionId = state.storage
      ? await state.storage.getHostLock(session.hostId)
      : undefined;
    if (!state.storage) {
      releaseProviderAccountLease(state, session);
      if (canRetryHostLoss(session)) {
        state.sessions.set(session.id, queueHostLossRetry(session));
        requeued.push(session.id);
      } else {
        state.sessions.set(session.id, finishHostLostSession(state, session));
      }
      releaseWorktree(state, worktree.id);
      state.pendingAcks.delete(session.id);
    } else if (!canRetryHostLoss(session)) {
      if (typeof state.storage.finishSession !== "function") continue;
      const handoff = hostLostTerminalHookHandoff(state, session);
      const finished = await state.storage.finishSession({
        sessionId: session.id,
        worktreeId: worktree.id,
        attemptId: session.attemptId!,
        status: "failed",
        queueShard: session.queueShard,
        completedAt: state.now(),
        errorCode: "host_lost",
        errorMessage: HOST_LOSS_TERMINAL_REASON,
        ...(handoff ? { terminalHookHandoff: handoff } : {}),
        expectedReconnectDeadlineAt: session.reconnectDeadlineAt,
        ...(session.assignmentConnectionId
          ? { expectedConnectionId: session.assignmentConnectionId }
          : {}),
        ...(connectionId ? { fence: { hostId: session.hostId, connectionId } } : {}),
        ...(session.concurrencyId ? { concurrencyId: session.concurrencyId } : {}),
        ...providerAccountLeaseWriteOpts(session),
      });
      if (!finished) continue;
      await releaseLegacyHostAssignmentAfterDurableTransition(state, session);
      releaseProviderAccountLease(state, session);
      state.sessions.set(session.id, finishHostLostSession(state, session, handoff));
      state.worktrees.set(worktree.id, {
        ...worktree,
        status: "idle",
        currentSessionId: null,
        online: false,
      });
      state.pendingAcks.delete(session.id);
    } else if (
      await state.storage.tryRequeueSession({
        sessionId: session.id,
        worktreeId: worktree.id,
        attemptId: session.attemptId!,
        queueShard: session.queueShard,
        reason: HOST_LOSS_RETRY_REASON,
        forceOffline: true,
        expectedHostId: session.hostId,
        expectedReconnectDeadlineAt: session.reconnectDeadlineAt,
        ...(session.assignmentConnectionId
          ? { expectedConnectionId: session.assignmentConnectionId }
          : {}),
        ...(connectionId ? { fence: { hostId: session.hostId, connectionId } } : {}),
        ...(!connectionId ? { requireNoHostLock: session.hostId } : {}),
        ...providerAccountLeaseWriteOpts(session),
        infrastructureErrorCode: "host_lost",
      })
    ) {
      await releaseLegacyHostAssignmentAfterDurableTransition(state, session);
      releaseProviderAccountLease(state, session);
      state.sessions.set(session.id, queueHostLossRetry(session));
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
