import type { SessionRecord } from "./db/types.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";

export function holdsScheduledLeaseLocal(
  state: ControlPlaneState,
  session: SessionRecord,
): boolean {
  if (!session.hostId || !session.assignmentConnectionId || !session.mainCheckoutLease)
    return false;
  const lease = state.mainCheckoutLeases.get(`${session.hostId}\0${session.repositoryId}`);
  return lease?.sessionId === session.id && lease?.connectionId === session.assignmentConnectionId;
}

export function releaseScheduledLeaseLocal(
  state: ControlPlaneState,
  session: SessionRecord,
): boolean {
  const hostId = session.hostId;
  if (!hostId || !holdsScheduledLeaseLocal(state, session)) return false;
  state.mainCheckoutLeases.delete(`${hostId}\0${session.repositoryId}`);
  return true;
}
