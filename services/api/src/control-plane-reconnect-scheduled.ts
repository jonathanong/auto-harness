import type { ControlPlaneState } from "./control-plane-state.ts";
import { queueReconnectSession } from "./control-plane-reconnect-session.ts";
import {
  providerAccountLeaseWriteOpts,
  releaseProviderAccountLease,
} from "./control-plane-provider-account-leases.ts";
import { releaseLegacyHostAssignmentAfterDurableTransition } from "./control-plane-legacy-host-assignment.ts";
import { releaseScheduledLeaseLocal } from "./control-plane-scheduled-assign.ts";

export type ScheduledReconnectConfirmation = {
  session: import("./db/types.ts").SessionRecord;
};

export async function confirmScheduledReconnect(
  state: ControlPlaneState,
  session: import("./db/types.ts").SessionRecord,
  hostId: string,
  connectionId: string | undefined,
): Promise<boolean> {
  const oldConnectionId = session.assignmentConnectionId;
  if (!oldConnectionId || !connectionId || !session.ackReceivedAt || session.status !== "running") {
    return false;
  }
  const confirmed =
    !state.storage ||
    (await state.storage.confirmMainCheckoutReconnect({
      sessionId: session.id,
      hostId,
      repositoryId: session.repositoryId,
      oldConnectionId,
      connectionId,
      ...(session.reconnectDeadlineAt ? { deadlineAt: session.reconnectDeadlineAt } : {}),
    }));
  if (!confirmed) return false;
  const lease = state.mainCheckoutLeases.get(`${hostId}\0${session.repositoryId}`);
  if (lease?.sessionId === session.id && lease.connectionId === oldConnectionId) {
    state.mainCheckoutLeases.set(`${hostId}\0${session.repositoryId}`, {
      ...lease,
      connectionId,
    });
  }
  const { reconnectDeadlineAt: _, ...next } = session;
  state.sessions.set(session.id, { ...next, assignmentConnectionId: connectionId });
  return true;
}

export async function requeueOmittedScheduled(
  state: ControlPlaneState,
  hostId: string,
  running: Set<string>,
  requeued: string[],
): Promise<void> {
  const storage = state.storage;
  const sessions =
    storage &&
    typeof (storage as { listSessionsByHost?: unknown }).listSessionsByHost === "function"
      ? await storage.listSessionsByHost(hostId)
      : [...state.sessions.values()].filter((session) => session.hostId === hostId);
  for (const session of sessions) {
    if (
      !session.mainCheckoutLease ||
      session.status !== "running" ||
      running.has(session.id) ||
      !session.assignmentConnectionId
    )
      continue;
    const released = state.storage
      ? await state.storage.releaseMainCheckoutSession({
          sessionId: session.id,
          hostId,
          repositoryId: session.repositoryId,
          connectionId: session.assignmentConnectionId,
          status: "queued",
          queueShard: session.queueShard,
          reason: "daemon did not report session after reconnect; requeued",
          ...providerAccountLeaseWriteOpts(session),
        })
      : releaseScheduledLeaseLocal(state, session);
    if (released) {
      await releaseLegacyHostAssignmentAfterDurableTransition(state, session);
      releaseProviderAccountLease(state, session);
      state.sessions.set(
        session.id,
        queueReconnectSession(session, "daemon did not report session after reconnect; requeued"),
      );
      state.pendingAcks.delete(session.id);
      requeued.push(session.id);
    }
  }
}

export async function restoreScheduledReconnects(
  state: ControlPlaneState,
  hostId: string,
  connectionId: string | undefined,
  confirmed: readonly ScheduledReconnectConfirmation[],
): Promise<void> {
  for (const item of confirmed.toReversed()) {
    const prior = item.session;
    const currentConnectionId = connectionId;
    if (!currentConnectionId || !prior.assignmentConnectionId) continue;
    // A forced replacement can report an active run before the old disconnect
    // callback has persisted a grace deadline. Rollback must still leave that
    // old fenced lease reclaimable after the new registration drops.
    const previousDeadlineAt =
      prior.reconnectDeadlineAt ??
      new Date(Date.parse(state.now()) + state.reconnectGraceMs).toISOString();
    const restored = state.storage
      ? await state.storage.restoreMainCheckoutReconnect({
          sessionId: prior.id,
          hostId,
          repositoryId: prior.repositoryId,
          connectionId: currentConnectionId,
          previousConnectionId: prior.assignmentConnectionId,
          previousDeadlineAt,
        })
      : true;
    if (!restored) continue;
    state.sessions.set(prior.id, { ...prior, reconnectDeadlineAt: previousDeadlineAt });
    state.mainCheckoutLeases.set(`${hostId}\0${prior.repositoryId}`, {
      sessionId: prior.id,
      connectionId: prior.assignmentConnectionId,
    });
  }
}

export async function reclaimScheduledReconnect(
  state: ControlPlaneState,
  session: import("./db/types.ts").SessionRecord,
  requeued: string[],
): Promise<boolean> {
  if (!session.mainCheckoutLease || !session.hostId || !session.assignmentConnectionId)
    return false;
  const cancelled = session.status === "cancelled";
  const released = state.storage
    ? await state.storage.releaseMainCheckoutSession({
        sessionId: session.id,
        hostId: session.hostId,
        repositoryId: session.repositoryId,
        connectionId: session.assignmentConnectionId,
        status: cancelled ? "cancelled" : "queued",
        queueShard: session.queueShard,
        reason: cancelled
          ? (session.errorMessage ?? "cancelled by operator")
          : "daemon reconnect deadline exceeded; requeued",
        ...(cancelled ? { expectedStatus: "cancelled" as const } : {}),
        ...(cancelled && session.concurrencyId ? { concurrencyId: session.concurrencyId } : {}),
        ...providerAccountLeaseWriteOpts(session),
      })
    : releaseScheduledLeaseLocal(state, session);
  if (released) {
    await releaseLegacyHostAssignmentAfterDurableTransition(state, session);
    if (state.storage) releaseScheduledLeaseLocal(state, session);
    releaseProviderAccountLease(state, session);
    if (cancelled) {
      const next = { ...session };
      delete next.mainCheckoutLease;
      delete next.assignmentConnectionId;
      delete next.assignmentSentAt;
      delete next.ackReceivedAt;
      delete next.reconnectDeadlineAt;
      state.sessions.set(session.id, next);
    } else {
      state.sessions.set(
        session.id,
        queueReconnectSession(session, "daemon reconnect deadline exceeded; requeued"),
      );
      requeued.push(session.id);
    }
    state.pendingAcks.delete(session.id);
  }
  return true;
}
