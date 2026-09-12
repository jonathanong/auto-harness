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
  activeSessions: readonly import("./db/types.ts").SessionRecord[],
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

/** Requeue an omitted workspace attempt and atomically release its exact slot. */
async function requeueOmittedWorkspaceSessions(
  state: ControlPlaneState,
  hostId: string,
  connectionId: string | undefined,
  running: ReadonlySet<string>,
  reason: string,
  requeued: string[],
  activeSessions: readonly import("./db/types.ts").SessionRecord[],
): Promise<void> {
  for (const session of activeSessions) {
    if (session.status !== "running" || !session.workspaceSlotId || running.has(session.id)) {
      continue;
    }
    const slot = state.storage
      ? await state.storage.getWorkspaceSlot(session.workspaceSlotId)
      : state.workspaceSlots.get(session.workspaceSlotId);
    if (
      !slot ||
      slot.status !== "busy" ||
      slot.currentSessionId !== session.id ||
      slot.hostId !== hostId
    ) {
      continue;
    }
    if (!state.storage) {
      releaseProviderAccountLease(state, session);
      state.sessions.set(session.id, queueReconnectSession(session, reason));
      const { errorMessage: _, ...cleanSlot } = slot;
      state.workspaceSlots.set(slot.id, {
        ...cleanSlot,
        status: "idle",
        currentSessionId: null,
      });
      state.pendingAcks.delete(session.id);
      requeued.push(session.id);
      continue;
    }
    if (!connectionId) continue;
    const released = await state.storage.finishSession({
      sessionId: session.id,
      worktreeId: null,
      workspaceSlotId: slot.id,
      attemptId: session.attemptId!,
      status: "queued",
      expectedStatus: "running",
      queueShard: session.queueShard,
      errorMessage: reason,
      fence: { hostId, connectionId },
      ...(session.concurrencyId ? { concurrencyId: session.concurrencyId } : {}),
      ...providerAccountLeaseWriteOpts(session),
      ...(session.hostAssignmentLease ? { hostAssignmentLease: session.hostAssignmentLease } : {}),
    });
    if (!released) continue;
    await releaseLegacyHostAssignmentAfterDurableTransition(state, session);
    releaseProviderAccountLease(state, session);
    state.sessions.set(session.id, queueReconnectSession(session, reason));
    const { errorMessage: _, ...cleanSlot } = slot;
    state.workspaceSlots.set(slot.id, {
      ...cleanSlot,
      status: "idle",
      currentSessionId: null,
    });
    state.pendingAcks.delete(session.id);
    requeued.push(session.id);
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
  );
  await requeueOmittedWorkspaceSessions(
    state,
    hostId,
    connectionId,
    running,
    reason,
    requeued,
    activeSessions,
  );
  await requeueOmittedScheduled(state, hostId, new Set(running), requeued, reason, activeSessions);
  return requeued;
}
