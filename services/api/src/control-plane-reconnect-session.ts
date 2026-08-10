import type { SessionRecord } from "./db/types.ts";

/** Prepare a disconnected running session for a fresh queue assignment. */
export function queueReconnectSession(session: SessionRecord, reason: string): SessionRecord {
  const {
    ackReceivedAt: _,
    reconnectDeadlineAt: __,
    assignmentConnectionId: ___,
    startedAt: ____,
    ...next
  } = session;
  return {
    ...next,
    status: "queued",
    hostId: null,
    worktreeId: null,
    errorMessage: reason,
  };
}
