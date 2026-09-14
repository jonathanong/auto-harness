import type { ControlPlaneState } from "./control-plane-state.ts";
import { requestAssignment } from "./request-assignment.ts";

/** Mark a local hub connection whose `host:register` is in-flight. */
export function markHostSocketPendingPublish(state: ControlPlaneState, connectionId: string): void {
  state.pendingHostSocketPublish.add(connectionId);
}

/** Clear the in-flight mark after publish, failed register, or socket close. */
export function clearHostSocketPendingPublish(
  state: ControlPlaneState,
  connectionId: string,
): void {
  state.pendingHostSocketPublish.delete(connectionId);
}

/**
 * Recovered sessions need a sweep, but not onto a winner whose socket is
 * still unpublished — `createWsDelivery` would hit the closing loser.
 */
export async function requestAssignmentAfterInMemoryRegisterRollback(
  state: ControlPlaneState,
  requeued: readonly string[],
  hostId: string,
  failedConnectionId: string,
): Promise<void> {
  if (requeued.length === 0) return;
  const winnerConnectionId = state.hostConnection.get(hostId);
  if (
    winnerConnectionId !== undefined &&
    winnerConnectionId !== failedConnectionId &&
    state.pendingHostSocketPublish.has(winnerConnectionId)
  ) {
    return;
  }
  await requestAssignment(state);
}
