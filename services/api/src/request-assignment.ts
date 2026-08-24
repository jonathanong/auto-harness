import type { ControlPlaneState } from "./control-plane-state.ts";
import { assignQueuedDurable } from "./control-plane-assign.ts";
import { assignScheduledQueuedDurable } from "./control-plane-scheduled-assign.ts";

/**
 * Best-effort prompt + scheduled assignment. Failures leave work for the
 * one-minute repair sweep; originating mutations must still succeed.
 */
export async function requestAssignment(state: ControlPlaneState): Promise<void> {
  try {
    await assignQueuedDurable(state);
    await assignScheduledQueuedDurable(state);
  } catch {
    // Originating create/register/terminal/capacity paths must not fail closed.
  }
}
