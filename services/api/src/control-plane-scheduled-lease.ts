import type { SessionRecord } from "./db/types.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";

export function releaseScheduledLeaseLocal(
  state: ControlPlaneState,
  session: SessionRecord,
): boolean {
  if (!session.hostId || !session.assignmentConnectionId || !session.mainCheckoutLease)
    return false;
  const key = `${session.hostId}\0${session.repositoryId}`;
  const lease = state.mainCheckoutLeases.get(key);
  if (
    !lease ||
    lease.sessionId !== session.id ||
    lease.connectionId !== session.assignmentConnectionId
  )
    return false;
  state.mainCheckoutLeases.delete(key);
  return true;
}
