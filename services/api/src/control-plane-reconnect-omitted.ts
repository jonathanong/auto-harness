import type { ControlPlaneState } from "./control-plane-state.ts";
import { queueReconnectSession } from "./control-plane-reconnect-session.ts";
import { releaseWorktree } from "./control-plane-worktrees.ts";
import { requeueOmittedScheduled } from "./control-plane-reconnect-scheduled.ts";
import {
  providerAccountLeaseWriteOpts,
  releaseProviderAccountLease,
} from "./control-plane-provider-account-leases.ts";
import { releaseLegacyHostAssignmentAfterDurableTransition } from "./control-plane-legacy-host-assignment.ts";
import {
  canRetryHostLoss,
  finishHostLostSession,
  hostLostTerminalHookHandoff,
  HOST_LOSS_RETRY_REASON,
  HOST_LOSS_TERMINAL_REASON,
  queueHostLossRetry,
} from "./control-plane-infrastructure-retry.ts";

/**
 * Requeue every worktree-owned session this host is not currently reporting as
 * running. Shared by register-time reconnect reconciliation (after its own
 * per-claim confirmation pass) and keepalive-time reconciliation (which has no
 * claims to confirm — the connection never changed).
 */
async function requeueOmittedWorktreeSessions(
  state: ControlPlaneState,
  hostId: string,
  connectionId: string | undefined,
  running: ReadonlySet<string>,
  reason: string,
  requeued: string[],
  activeSessions: readonly import("./db/types.ts").SessionRecord[],
  terminalHookHandoffSessionIds?: string[],
): Promise<void> {
  for (const session of activeSessions) {
    if (session.status !== "running" || !session.worktreeId) continue;
    // Cheap membership check before a per-worktree durable read: on a healthy
    // host with many concurrent sessions, this is the common case on every
    // 20s keepalive and would otherwise cost one storage read per worktree
    // for sessions that need no reconciliation at all.
    if (running.has(session.id)) continue;
    const worktree = state.storage
      ? await state.storage.getWorktree(session.worktreeId)
      : state.worktrees.get(session.worktreeId);
    if (
      !worktree ||
      worktree.status !== "busy" ||
      worktree.currentSessionId !== session.id ||
      worktree.hostId !== hostId
    )
      continue;
    const retryableHostLoss = Boolean(session.ackReceivedAt) && canRetryHostLoss(session);
    const terminalHostLoss = Boolean(session.ackReceivedAt) && !canRetryHostLoss(session);
    if (!state.storage) {
      releaseProviderAccountLease(state, session);
      const handoff = terminalHostLoss ? hostLostTerminalHookHandoff(state, session) : undefined;
      state.sessions.set(
        session.id,
        retryableHostLoss
          ? queueHostLossRetry(session)
          : terminalHostLoss
            ? finishHostLostSession(state, session, handoff)
            : queueReconnectSession(session, reason),
      );
      if (!handoff) releaseWorktree(state, worktree.id);
      state.pendingAcks.delete(session.id);
      if (handoff) terminalHookHandoffSessionIds?.push(session.id);
      if (!terminalHostLoss) requeued.push(session.id);
    } else if (
      retryableHostLoss &&
      (await state.storage.tryRequeueSession({
        sessionId: session.id,
        worktreeId: worktree.id,
        attemptId: session.attemptId!,
        queueShard: session.queueShard,
        reason: HOST_LOSS_RETRY_REASON,
        forceOffline: false,
        expectedHostId: hostId,
        nextConnectionId: connectionId!,
        ...(session.assignmentConnectionId
          ? { expectedConnectionId: session.assignmentConnectionId }
          : {}),
        fence: { hostId, connectionId: connectionId! },
        ...providerAccountLeaseWriteOpts(session),
        infrastructureErrorCode: "host_lost",
      }))
    ) {
      await releaseLegacyHostAssignmentAfterDurableTransition(state, session);
      releaseProviderAccountLease(state, session);
      state.sessions.set(session.id, queueHostLossRetry(session));
      state.worktrees.set(worktree.id, {
        ...worktree,
        status: "idle",
        currentSessionId: null,
        online: true,
      });
      state.pendingAcks.delete(session.id);
      requeued.push(session.id);
    } else if (terminalHostLoss) {
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
        fence: { hostId, connectionId: connectionId! },
        ...(session.concurrencyId ? { concurrencyId: session.concurrencyId } : {}),
        ...providerAccountLeaseWriteOpts(session),
      });
      if (!finished) continue;
      await releaseLegacyHostAssignmentAfterDurableTransition(state, session);
      releaseProviderAccountLease(state, session);
      state.sessions.set(session.id, finishHostLostSession(state, session, handoff));
      if (handoff) terminalHookHandoffSessionIds?.push(session.id);
      if (handoff) {
        // finishSession leaves the matching target reservation in place until
        // its hook settles or expires; retain the same view in this worker.
        state.worktrees.set(worktree.id, {
          ...worktree,
          status: "busy",
          currentSessionId: session.id,
          online: true,
        });
      } else {
        state.worktrees.set(worktree.id, {
          ...worktree,
          status: "idle",
          currentSessionId: null,
          online: true,
        });
      }
      state.pendingAcks.delete(session.id);
    } else if (
      await state.storage.tryRequeueSession({
        sessionId: session.id,
        worktreeId: worktree.id,
        attemptId: session.attemptId!,
        queueShard: session.queueShard,
        reason,
        forceOffline: false,
        expectedHostId: hostId,
        nextConnectionId: connectionId!,
        ...(session.assignmentConnectionId
          ? { expectedConnectionId: session.assignmentConnectionId }
          : {}),
        fence: { hostId, connectionId: connectionId! },
        ...providerAccountLeaseWriteOpts(session),
      })
    ) {
      await releaseLegacyHostAssignmentAfterDurableTransition(state, session);
      releaseProviderAccountLease(state, session);
      state.sessions.set(session.id, queueReconnectSession(session, reason));
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
}

/**
 * Requeue every session (worktree- or main-checkout-owned) this host claims to
 * own server-side but does not include in `running`. `connectionId` must be
 * the host's current, already-fenced connection when `state.storage` is set —
 * callers validate this before invoking (register/reconnect confirms a claim
 * first; keepalive validates the host lock in its own fence check).
 */
export async function reconcileHostOwnedSessions(
  state: ControlPlaneState,
  hostId: string,
  connectionId: string | undefined,
  running: ReadonlySet<string>,
  reason: string,
  terminalHookHandoffSessionIds?: string[],
): Promise<string[]> {
  const requeued: string[] = [];
  const activeSessions = state.storage
    ? typeof state.storage.listActiveSessionsByHost === "function"
      ? await state.storage.listActiveSessionsByHost(hostId)
      : [...state.sessions.values()].filter((session) => session.hostId === hostId)
    : [...state.sessions.values()].filter((session) => session.hostId === hostId);
  await requeueOmittedWorktreeSessions(
    state,
    hostId,
    connectionId,
    running,
    reason,
    requeued,
    activeSessions,
    terminalHookHandoffSessionIds,
  );
  await requeueOmittedScheduled(
    state,
    hostId,
    new Set(running),
    requeued,
    reason,
    activeSessions,
    terminalHookHandoffSessionIds,
  );
  return requeued;
}
