import type { SessionRecord } from "./db/types.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";
import { queueSessionArchive } from "./control-plane-archive.ts";
import { noteSlackSessionLifecycle } from "./control-plane-state.ts";
import { queueReconnectSession } from "./control-plane-reconnect-session.ts";
import {
  emitInfrastructureRetry,
  emitInfrastructureRetryExhausted,
} from "./operational-metrics.ts";

export const HOST_LOSS_RETRY_REASON = "host was lost before command launch; retrying once";
export const HOST_LOSS_TERMINAL_REASON =
  "host lost after command authorization or retry exhaustion";
const TERMINAL_HOOK_HANDOFF_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Legacy/missing checkpoints are deliberately not replay-safe. */
export function canRetryHostLoss(session: SessionRecord): boolean {
  return (
    session.primaryCommandStartState === "pending" && (session.infrastructureRetryCount ?? 0) < 1
  );
}

export function queueHostLossRetry(session: SessionRecord): SessionRecord {
  emitInfrastructureRetry();
  return {
    ...queueReconnectSession(session, HOST_LOSS_RETRY_REASON),
    infrastructureRetryCount: (session.infrastructureRetryCount ?? 0) + 1,
    lastInfrastructureErrorCode: "host_lost",
    ...(session.attemptId ? { infrastructureRetryAttemptId: session.attemptId } : {}),
  };
}

export function finishHostLostSession(
  state: ControlPlaneState,
  session: SessionRecord,
  handoff = hostLostTerminalHookHandoff(state, session),
): SessionRecord {
  if ((session.infrastructureRetryCount ?? 0) >= 1) emitInfrastructureRetryExhausted();
  const next: SessionRecord = {
    ...session,
    status: "failed",
    completedAt: state.now(),
    errorCode: "host_lost",
    errorMessage: HOST_LOSS_TERMINAL_REASON,
    worktreeId: null,
    hostId: null,
    ...(handoff ? { terminalHookHandoff: handoff } : {}),
  };
  delete next.mainCheckoutLease;
  delete next.assignmentConnectionId;
  delete next.assignmentSentAt;
  delete next.ackReceivedAt;
  delete next.reconnectDeadlineAt;
  if (!handoff) {
    delete next.activeHostId;
    delete next.activeHostOrder;
  }
  delete next.primaryCommandStartState;
  delete next.providerAccountLease;
  delete next.hostAssignmentLease;
  // The replacement daemon is the terminal-hook owner. It queues the archive
  // only after its durable completion acknowledgement clears this handoff.
  if (!handoff) queueSessionArchive(state, session.id);
  noteSlackSessionLifecycle(state, next);
  return next;
}

/** Snapshot only route metadata; the replacement daemon resolves its live local hook policy. */
export function hostLostTerminalHookHandoff(
  state: ControlPlaneState,
  session: SessionRecord,
): SessionRecord["terminalHookHandoff"] | undefined {
  if (!session.hostId) return undefined;
  return {
    handoffId: state.idFactory(),
    hostId: session.hostId,
    repositoryId: session.repositoryId,
    worktreeId: session.worktreeId ?? null,
    status: "failed",
    errorCode: "host_lost",
    expiresAt: new Date(Date.parse(state.now()) + TERMINAL_HOOK_HANDOFF_MAX_AGE_MS).toISOString(),
    ...(session.ref !== undefined ? { ref: session.ref } : {}),
    ...(session.metadata !== undefined ? { metadata: session.metadata } : {}),
  };
}
