import type { ControlPlaneState } from "./control-plane-state.ts";
import { queueReconnectSession } from "./control-plane-reconnect-session.ts";
import { releaseWorktree } from "./control-plane-worktrees.ts";
import { requeueOmittedScheduled } from "./control-plane-reconnect-scheduled.ts";
import {
  providerAccountLeaseWriteOpts,
  releaseProviderAccountLease,
} from "./control-plane-provider-account-leases.ts";
import { releaseLegacyHostAssignmentAfterDurableTransition } from "./control-plane-legacy-host-assignment.ts";

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
): Promise<void> {
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
      releaseProviderAccountLease(state, session);
      state.sessions.set(session.id, queueReconnectSession(session, reason));
      releaseWorktree(state, worktree.id);
      state.pendingAcks.delete(session.id);
      requeued.push(session.id);
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
): Promise<string[]> {
  const requeued: string[] = [];
  await requeueOmittedWorktreeSessions(state, hostId, connectionId, running, reason, requeued);
  await requeueOmittedScheduled(state, hostId, new Set(running), requeued);
  return requeued;
}
