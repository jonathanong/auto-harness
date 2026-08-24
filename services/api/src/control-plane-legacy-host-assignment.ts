import type { ControlPlaneState } from "./control-plane-state.ts";
import { legacyHostAssignmentForSession } from "./db/plane-storage-sessions-plan.ts";
import type { SessionRecord } from "./db/types.ts";

/**
 * Reconcile a legacy host-capacity occupant after its durable lifecycle
 * transition commits. Legacy rows have no persisted host lease, so folding
 * this decrement into the transaction can manufacture a zero counter.
 */
export async function releaseLegacyHostAssignmentAfterDurableTransition(
  state: ControlPlaneState,
  session: SessionRecord,
): Promise<void> {
  const lease = legacyHostAssignmentForSession(session);
  if (lease) await releaseLegacyHostAssignment(state, lease);
}

export async function releaseLegacyHostAssignment(
  state: ControlPlaneState,
  lease: { sessionId: string; attemptId: string; hostId: string; connectionId: string },
): Promise<void> {
  const storage = state.storage;
  const release = storage?.releaseLegacyHostAssignment;
  if (!storage || typeof release !== "function") return;
  try {
    let connectionId = lease.connectionId;
    const attemptedFences = new Set<string>();
    while (!attemptedFences.has(connectionId)) {
      attemptedFences.add(connectionId);
      if (await release.call(storage, { ...lease, connectionId })) return;

      // Re-registration intentionally preserves assignmentCount while changing
      // the connection fence. The storage transaction couples the decrement
      // to a per-session marker, so retrying cannot release this slot twice.
      const getHostLockState = storage.getHostLockState;
      if (typeof getHostLockState !== "function") return;
      const current = await getHostLockState.call(storage, lease.hostId);
      if (!current.connectionId) return;
      connectionId = current.connectionId;
    }
  } catch (error) {
    // The durable lifecycle transition already committed. Capacity repair is
    // intentionally best effort for old rows and must never undo it.
    console.error("legacy host assignment release failed", error);
  }
}
