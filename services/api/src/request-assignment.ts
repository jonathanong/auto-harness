import type { ControlPlaneState } from "./control-plane-state.ts";
import { assignQueuedDurable } from "./control-plane-assign.ts";
import { assignScheduledQueuedDurable } from "./control-plane-scheduled-assign.ts";
import { compareSessionsForQueue } from "./control-plane-ordering.ts";
import {
  listQueuedSessionsDurable,
  refreshSchedulerReadModel,
} from "./control-plane-durable-read-runtime.ts";

/** Prompt + scheduled assignment in one global priority/FIFO sweep. */
export async function assignQueuedAndScheduledDurable(state: ControlPlaneState): Promise<{
  queuedAssigned: Awaited<ReturnType<typeof assignQueuedDurable>>;
  scheduledAssigned: Awaited<ReturnType<typeof assignScheduledQueuedDurable>>;
}> {
  // Both session types share one priority/FIFO queue. Process one queue head
  // at a time so a prompt backlog cannot starve a higher-priority schedule.
  if (state.storage) {
    if (typeof state.storage.backfillQueuedSessionQueueOrder === "function") {
      await state.storage.backfillQueuedSessionQueueOrder(state.shardCount);
    }
    const [promptQueued, scheduledQueued] = await Promise.all([
      listQueuedSessionsDurable(state, "prompt"),
      listQueuedSessionsDurable(state, "scheduled"),
    ]);
    if (promptQueued.length === 0 && scheduledQueued.length === 0) {
      return { queuedAssigned: [], scheduledAssigned: [] };
    }
    await refreshSchedulerReadModel(state);
  }
  const queued = [...state.sessions.values()]
    .filter((session) => session.status === "queued")
    .toSorted(compareSessionsForQueue);
  const queuedAssigned: Awaited<ReturnType<typeof assignQueuedDurable>> = [];
  const scheduledAssigned: Awaited<ReturnType<typeof assignScheduledQueuedDurable>> = [];
  for (const session of queued) {
    try {
      if (session.type === "scheduled") {
        scheduledAssigned.push(
          ...(await assignScheduledQueuedDurable(state, session.id, { readModelLoaded: true })),
        );
      } else {
        queuedAssigned.push(
          ...(await assignQueuedDurable(state, session.id, { readModelLoaded: true })),
        );
      }
    } catch {
      // A transient placement failure must not prevent later queue entries
      // from getting a chance during this repair pass.
    }
  }
  return { queuedAssigned, scheduledAssigned };
}

export async function requestAssignment(state: ControlPlaneState): Promise<void> {
  try {
    await assignQueuedAndScheduledDurable(state);
  } catch {
    // Originating create/register/terminal/capacity paths must not fail closed.
  }
}
