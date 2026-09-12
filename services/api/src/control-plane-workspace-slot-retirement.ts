import type { ControlPlaneState } from "./control-plane-state.ts";
import { queueWrite } from "./control-plane-state.ts";

/**
 * A removed, in-flight slot is a tombstone rather than an idle capacity unit.
 * Once its recorded owner is gone, remove it locally and (when available)
 * conditionally from the durable projection.
 */
export function removeReleasedRetiredWorkspaceSlot(
  state: ControlPlaneState,
  slotId: string,
): boolean {
  const slot = state.workspaceSlots.get(slotId);
  if (!slot?.retired || slot.currentSessionId != null) return false;
  state.workspaceSlots.delete(slotId);
  if (state.storage) {
    queueWrite(state, (storage) =>
      storage!.deleteRetiredWorkspaceSlotIfIdle(slotId).then(() => undefined),
    );
  }
  return true;
}

/** Delete the durable tombstone after its terminal transaction released it. */
export async function removeReleasedRetiredWorkspaceSlotDurable(
  state: ControlPlaneState,
  slotId: string,
): Promise<boolean> {
  const slot = state.workspaceSlots.get(slotId);
  if (!slot?.retired || slot.currentSessionId != null) return false;
  if (
    state.storage?.deleteRetiredWorkspaceSlotIfIdle &&
    !(await state.storage.deleteRetiredWorkspaceSlotIfIdle(slotId))
  ) {
    return false;
  }
  state.workspaceSlots.delete(slotId);
  return true;
}
