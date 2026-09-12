import type { ControlPlaneState } from "./control-plane-state.ts";
import type { SessionRecord } from "./db/types.ts";

export type ScheduledReconnectConfirmation = { session: SessionRecord };

export async function confirmScheduledReconnect(
  state: ControlPlaneState,
  session: SessionRecord,
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
    state.mainCheckoutLeases.set(`${hostId}\0${session.repositoryId}`, { ...lease, connectionId });
  }
  const { reconnectDeadlineAt: _, ...next } = session;
  state.sessions.set(session.id, { ...next, assignmentConnectionId: connectionId });
  return true;
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
