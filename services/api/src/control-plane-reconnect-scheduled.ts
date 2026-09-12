import type { ControlPlaneState } from "./control-plane-state.ts";
import { queueReconnectSession } from "./control-plane-reconnect-session.ts";
import {
  providerAccountLeaseWriteOpts,
  releaseProviderAccountLease,
} from "./control-plane-provider-account-leases.ts";
import { releaseLegacyHostAssignmentAfterDurableTransition } from "./control-plane-legacy-host-assignment.ts";
import { releaseScheduledLeaseLocal } from "./control-plane-scheduled-assign.ts";
import {
  canRetryHostLoss,
  finishHostLostSession,
  HOST_LOSS_RETRY_REASON,
  HOST_LOSS_TERMINAL_REASON,
  queueHostLossRetry,
} from "./control-plane-infrastructure-retry.ts";

export {
  confirmScheduledReconnect,
  restoreScheduledReconnects,
} from "./control-plane-reconnect-scheduled-confirm.ts";

export async function requeueOmittedScheduled(
  state: ControlPlaneState,
  hostId: string,
  running: Set<string>,
  requeued: string[],
  reason = "daemon did not report session after reconnect; requeued",
  activeSessions?: readonly import("./db/types.ts").SessionRecord[],
): Promise<void> {
  const storage = state.storage;
  const sessions =
    activeSessions ??
    (storage && typeof storage.listActiveSessionsByHost === "function"
      ? await storage.listActiveSessionsByHost(hostId)
      : [...state.sessions.values()].filter((session) => session.hostId === hostId));
  for (const session of sessions) {
    if (
      !session.mainCheckoutLease ||
      session.status !== "running" ||
      running.has(session.id) ||
      !session.assignmentConnectionId
    )
      continue;
    const retryableHostLoss = Boolean(session.ackReceivedAt) && canRetryHostLoss(session);
    const terminalHostLoss = Boolean(session.ackReceivedAt) && !canRetryHostLoss(session);
    const released = state.storage
      ? await state.storage.releaseMainCheckoutSession({
          sessionId: session.id,
          hostId,
          repositoryId: session.repositoryId,
          connectionId: session.assignmentConnectionId,
          status: terminalHostLoss ? "failed" : "queued",
          queueShard: session.queueShard,
          reason: terminalHostLoss
            ? HOST_LOSS_TERMINAL_REASON
            : retryableHostLoss
              ? HOST_LOSS_RETRY_REASON
              : reason,
          ...(terminalHostLoss
            ? {
                completedAt: state.now(),
                errorCode: "host_lost",
                ...(session.concurrencyId ? { concurrencyId: session.concurrencyId } : {}),
              }
            : retryableHostLoss
              ? { infrastructureErrorCode: "host_lost" as const }
              : {}),
          ...providerAccountLeaseWriteOpts(session),
        })
      : releaseScheduledLeaseLocal(state, session);
    if (released) {
      await releaseLegacyHostAssignmentAfterDurableTransition(state, session);
      releaseProviderAccountLease(state, session);
      state.sessions.set(
        session.id,
        retryableHostLoss
          ? queueHostLossRetry(session)
          : terminalHostLoss
            ? finishHostLostSession(state, session)
            : queueReconnectSession(session, reason),
      );
      state.pendingAcks.delete(session.id);
      if (!terminalHostLoss) requeued.push(session.id);
    }
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
  const retryableHostLoss =
    !cancelled && Boolean(session.ackReceivedAt) && canRetryHostLoss(session);
  const terminalHostLoss =
    !cancelled && Boolean(session.ackReceivedAt) && !canRetryHostLoss(session);
  const released = state.storage
    ? await state.storage.releaseMainCheckoutSession({
        sessionId: session.id,
        hostId: session.hostId,
        repositoryId: session.repositoryId,
        connectionId: session.assignmentConnectionId,
        status: cancelled ? "cancelled" : terminalHostLoss ? "failed" : "queued",
        queueShard: session.queueShard,
        reason: cancelled
          ? (session.errorMessage ?? "cancelled by operator")
          : terminalHostLoss
            ? HOST_LOSS_TERMINAL_REASON
            : retryableHostLoss
              ? HOST_LOSS_RETRY_REASON
              : "daemon reconnect deadline exceeded; requeued",
        ...(terminalHostLoss
          ? {
              completedAt: state.now(),
              errorCode: "host_lost",
              ...(session.concurrencyId ? { concurrencyId: session.concurrencyId } : {}),
            }
          : retryableHostLoss
            ? { infrastructureErrorCode: "host_lost" as const }
            : {}),
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
      delete next.activeHostId;
      delete next.activeHostOrder;
      state.sessions.set(session.id, next);
    } else {
      state.sessions.set(
        session.id,
        retryableHostLoss
          ? queueHostLossRetry(session)
          : terminalHostLoss
            ? finishHostLostSession(state, session)
            : queueReconnectSession(session, "daemon reconnect deadline exceeded; requeued"),
      );
      if (!terminalHostLoss) requeued.push(session.id);
    }
    state.pendingAcks.delete(session.id);
  }
  return true;
}
