import type { SessionRecord } from "./db/types.ts";

type HydrateScheduledState = {
  sessions: Map<string, SessionRecord>;
  pendingAcks: { clear(): void };
  mainCheckoutLeases: Map<string, { sessionId: string; connectionId: string }>;
};

export function hydrateScheduledState(
  state: HydrateScheduledState,
  sessions: readonly SessionRecord[],
): void {
  state.sessions.clear();
  state.pendingAcks.clear();
  state.mainCheckoutLeases.clear();
  for (const session of sessions) {
    state.sessions.set(session.id, session);
    if (!session.mainCheckoutLease || !session.hostId || !session.assignmentConnectionId) continue;
    state.mainCheckoutLeases.set(`${session.hostId}\0${session.repositoryId}`, {
      sessionId: session.id,
      connectionId: session.assignmentConnectionId,
    });
  }
}
