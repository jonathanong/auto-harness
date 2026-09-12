import type { SessionRecord } from "./db/types.ts";

/** Prepare a disconnected running session for a fresh queue assignment. */
export function queueReconnectSession(session: SessionRecord, reason: string): SessionRecord {
  const {
    ackReceivedAt: _,
    reconnectDeadlineAt: __,
    assignmentConnectionId: ___,
    assignmentSentAt: ______,
    startedAt: ____,
    mainCheckoutLease: _____,
    workspaceSlotId: _workspaceSlotId,
    workspaceSlotLease: _workspaceSlotLease,
    providerAccountLease: _______,
    activeHostId: ________,
    activeHostOrder: _________,
    result: __________,
    primaryCommandStartState: _primaryCommandStartState,
    sessionApiKeyHash: _sessionApiKeyHash,
    ...next
  } = session;
  return {
    ...next,
    status: "queued",
    hostId: null,
    worktreeId: null,
    workspaceSlotId: null,
    errorMessage: reason,
  };
}
