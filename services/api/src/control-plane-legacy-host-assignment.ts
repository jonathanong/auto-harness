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
  lease: { hostId: string; connectionId: string },
): Promise<void> {
  const release = state.storage?.releaseLegacyHostAssignment;
  if (typeof release !== "function") return;
  try {
    await release.call(state.storage, lease);
  } catch (error) {
    // The durable lifecycle transition already committed. Capacity repair is
    // intentionally best effort for old rows and must never undo it.
    console.error("legacy host assignment release failed", error);
  }
}
