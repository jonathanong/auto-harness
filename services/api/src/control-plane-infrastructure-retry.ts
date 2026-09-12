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
  };
}

export function finishHostLostSession(
  state: ControlPlaneState,
  session: SessionRecord,
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
  };
  delete next.mainCheckoutLease;
  delete next.assignmentConnectionId;
  delete next.assignmentSentAt;
  delete next.ackReceivedAt;
  delete next.reconnectDeadlineAt;
  delete next.activeHostId;
  delete next.activeHostOrder;
  delete next.primaryCommandStartState;
  delete next.providerAccountLease;
  delete next.hostAssignmentLease;
  queueSessionArchive(state, session.id);
  noteSlackSessionLifecycle(state, next);
  return next;
}
