/* eslint-disable max-lines -- durable disconnect must release every held lease. */
import type { ControlPlaneState } from "./control-plane-state.ts";
import { disconnectScheduledMainCheckouts } from "./control-plane-worktrees-disconnect-scheduled.ts";
import { releaseLegacyHostAssignmentAfterDurableTransition } from "./control-plane-legacy-host-assignment.ts";
import {
  providerAccountLeaseWriteOpts,
  releaseProviderAccountLease,
} from "./control-plane-provider-account-leases.ts";
import {
  canRetryHostLoss,
  finishHostLostSession,
  HOST_LOSS_RETRY_REASON,
  HOST_LOSS_TERMINAL_REASON,
  queueHostLossRetry,
} from "./control-plane-infrastructure-retry.ts";

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
        attemptId: session.attemptId!,
        ...(session.concurrencyId !== undefined ? { concurrencyId: session.concurrencyId } : {}),
        ...providerAccountLeaseWriteOpts(session),
      });
      if (released) {
        await releaseLegacyHostAssignmentAfterDurableTransition(state, session);
        releaseProviderAccountLease(state, session);
        state.sessions.set(sessionId, { ...session, worktreeId: null });
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
        assignmentConnectionId: connectionId,
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
      } else {
        const latestSession = await state.storage.getSession(sessionId);
        const latestWorktree = await state.storage.getWorktree(wt.id);
        const canRequeue =
          latestSession?.status === "running" &&
          latestSession.hostId === hostId &&
          latestSession.worktreeId === wt.id &&
          !latestSession.reconnectDeadlineAt;
        const retryableHostLoss = canRequeue && canRetryHostLoss(latestSession);
        const terminalHostLoss = canRequeue && !canRetryHostLoss(latestSession);
        if (terminalHostLoss && latestWorktree) {
          if (typeof state.storage.finishSession !== "function") continue;
          const finished = await state.storage.finishSession({
            sessionId,
            worktreeId: wt.id,
            attemptId: latestSession.attemptId!,
            status: "failed",
            queueShard: latestSession.queueShard,
            completedAt: state.now(),
            errorCode: "host_lost",
            errorMessage: HOST_LOSS_TERMINAL_REASON,
            fence: { hostId, connectionId },
            ...(latestSession.concurrencyId ? { concurrencyId: latestSession.concurrencyId } : {}),
            ...providerAccountLeaseWriteOpts(latestSession),
          });
          if (finished) {
            await releaseLegacyHostAssignmentAfterDurableTransition(state, latestSession);
            releaseProviderAccountLease(state, latestSession);
            state.sessions.set(sessionId, finishHostLostSession(state, latestSession));
            state.worktrees.set(wt.id, {
              ...latestWorktree,
              status: "idle",
              currentSessionId: null,
              online: false,
            });
            state.pendingAcks.delete(sessionId);
          }
          continue;
        }
        const requeuedNow =
          retryableHostLoss &&
          (await state.storage.tryRequeueSession({
            sessionId,
            worktreeId: wt.id,
            attemptId: latestSession.attemptId!,
            queueShard: latestSession.queueShard,
            reason: HOST_LOSS_RETRY_REASON,
            forceOffline: true,
            expectedHostId: hostId,
            expectedConnectionId: connectionId,
            fence: { hostId, connectionId },
            ...providerAccountLeaseWriteOpts(latestSession),
            infrastructureErrorCode: "host_lost",
          }));
        if (requeuedNow) {
          await releaseLegacyHostAssignmentAfterDurableTransition(state, latestSession);
          releaseProviderAccountLease(state, latestSession);
          const {
            ackReceivedAt: _,
            assignmentConnectionId: __,
            reconnectDeadlineAt: ___,
            startedAt: ____,
            activeHostId: _____,
            activeHostOrder: ______,
            ...queuedSession
          } = latestSession;
          state.sessions.set(sessionId, {
            ...queueHostLossRetry(queuedSession),
          });
          state.pendingAcks.delete(sessionId);
          state.worktrees.set(wt.id, {
            ...(latestWorktree ?? wt),
            status: "idle",
            currentSessionId: null,
            online: false,
          });
          requeued.push(sessionId);
        } else {
          const currentSession = canRequeue
            ? await state.storage.getSession(sessionId)
            : latestSession;
          const currentWorktree = canRequeue
            ? await state.storage.getWorktree(wt.id)
            : latestWorktree;
          if (currentSession) state.sessions.set(sessionId, currentSession);
          else state.sessions.delete(sessionId);
          if (currentWorktree) state.worktrees.set(wt.id, currentWorktree);
          else state.worktrees.delete(wt.id);
        }
      }
      continue;
    }
    const won = await state.storage.tryRequeueSession({
      sessionId,
      worktreeId: wt.id,
      attemptId: session.attemptId!,
      queueShard: session.queueShard,
      reason,
      forceOffline: true,
      expectedConnectionId: connectionId,
      fence: { hostId, connectionId },
      ...providerAccountLeaseWriteOpts(session),
    });
    if (won) {
      await releaseLegacyHostAssignmentAfterDurableTransition(state, session);
      releaseProviderAccountLease(state, session);
      const queued = {
        ...session,
        status: "queued" as const,
        worktreeId: null,
        hostId: null,
        errorMessage: reason,
      };
      delete queued.activeHostId;
      delete queued.activeHostOrder;
      state.sessions.set(sessionId, queued);
      state.pendingAcks.delete(sessionId);
      state.worktrees.set(wt.id, {
        ...wt,
        status: "idle",
        currentSessionId: null,
        online: false,
      });
      requeued.push(sessionId);
    } else {
      const latest = await state.storage.getWorktree(wt.id);
      if (latest) state.worktrees.set(wt.id, latest);
      const latestSession = await state.storage.getSession(sessionId);
      if (latestSession) state.sessions.set(sessionId, latestSession);
    }
  }
  await disconnectScheduledMainCheckouts(state, hostId, connectionId, reason, requeued);
  return requeued;
}
