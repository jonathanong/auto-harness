import type { ControlPlaneState } from "./control-plane-state.ts";
import type { SessionRecord } from "./db/types.ts";
import { assignQueuedDurable } from "./control-plane-assign.ts";
import { assignScheduledQueuedDurable } from "./control-plane-scheduled-assign.ts";
import { assignWorkspaceQueuedDurable } from "./control-plane-workspace-assign.ts";
import { compareSessionsForQueue } from "./control-plane-ordering.ts";
import { refreshAssignmentReadinessDurable } from "./control-plane-assignment-readiness.ts";
import { refreshAssignmentCommandsDurable } from "./control-plane-assignment-command-refresh.ts";
import {
  listQueuedSessionsDurable,
  refreshSchedulerReadModel,
} from "./control-plane-durable-read-runtime.ts";

const EVENT_DRIVEN_ASSIGNMENT_BATCH_SIZE = 25;
const EVENT_DRIVEN_ASSIGNMENT_BUDGET_MS = 2_000;

export type AssignmentSweepOptions = {
  /** Maximum queued sessions examined by one event-driven invocation. */
  maxSessions?: number;
  /** Time budget for the assignment portion; remaining work stays queued for cron. */
  budgetMs?: number;
  /** Injectable clock for deterministic boundary tests. */
  now?: () => number;
  /** Use the complete durable queue scan reserved for the cron repair pass. */
  fullScan?: boolean;
};

/** Prompt + scheduled assignment in one global priority/FIFO sweep. */
export async function assignQueuedAndScheduledDurable(
  state: ControlPlaneState,
  options: AssignmentSweepOptions = {},
): Promise<{
  queuedAssigned: Awaited<ReturnType<typeof assignQueuedDurable>>;
  scheduledAssigned: Awaited<ReturnType<typeof assignScheduledQueuedDurable>>;
  workspaceAssigned: Awaited<ReturnType<typeof assignWorkspaceQueuedDurable>>;
}> {
  const fullScan = options.fullScan === true;
  const maxSessions = fullScan
    ? Number.POSITIVE_INFINITY
    : (options.maxSessions ?? EVENT_DRIVEN_ASSIGNMENT_BATCH_SIZE);
  const budgetMs = fullScan
    ? Number.POSITIVE_INFINITY
    : (options.budgetMs ?? EVENT_DRIVEN_ASSIGNMENT_BUDGET_MS);
  const now = options.now ?? Date.now;
  const startedAt = now();
  let queued: SessionRecord[];
  // Both session types share one priority/FIFO queue. Process one queue head
  // at a time so a prompt backlog cannot starve a higher-priority schedule.
  if (state.storage) {
    if (fullScan && typeof state.storage.backfillQueuedSessionQueueOrder === "function") {
      await state.storage.backfillQueuedSessionQueueOrder(state.shardCount);
    }
    const queueOptions = fullScan ? {} : { limit: maxSessions };
    const [promptQueued, scheduledQueued, workspaceQueued] = await Promise.all([
      listQueuedSessionsDurable(state, "prompt", queueOptions),
      listQueuedSessionsDurable(state, "scheduled", queueOptions),
      listQueuedSessionsDurable(state, "workspace", queueOptions),
    ]);
    if (promptQueued.length === 0 && scheduledQueued.length === 0 && workspaceQueued.length === 0) {
      return { queuedAssigned: [], scheduledAssigned: [], workspaceAssigned: [] };
    }
    if (fullScan) {
      await refreshSchedulerReadModel(state);
    } else {
      // Bound event-path reads while making every unrefreshed profile fail
      // closed until the complete cron repair refreshes the whole model.
      await refreshAssignmentReadinessDurable(state, maxSessions);
      await refreshAssignmentCommandsDurable(state, [
        ...promptQueued,
        ...scheduledQueued,
        ...workspaceQueued,
      ]);
    }
    queued = [...promptQueued, ...scheduledQueued, ...workspaceQueued].toSorted(
      compareSessionsForQueue,
    );
  } else {
    queued = [...state.sessions.values()]
      .filter((session) => session.status === "queued")
      .toSorted(compareSessionsForQueue);
  }
  const queuedAssigned: Awaited<ReturnType<typeof assignQueuedDurable>> = [];
  const scheduledAssigned: Awaited<ReturnType<typeof assignScheduledQueuedDurable>> = [];
  const workspaceAssigned: Awaited<ReturnType<typeof assignWorkspaceQueuedDurable>> = [];
  let examined = 0;
  for (const session of queued) {
    if (examined >= maxSessions || now() - startedAt >= budgetMs) break;
    examined += 1;
    try {
      if (session.type === "scheduled") {
        scheduledAssigned.push(
          ...(await assignScheduledQueuedDurable(state, session.id, { readModelLoaded: true })),
        );
      } else if (session.type === "workspace") {
        workspaceAssigned.push(
          ...(await assignWorkspaceQueuedDurable(state, session.id, { readModelLoaded: true })),
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
  return { queuedAssigned, scheduledAssigned, workspaceAssigned };
}

export async function requestAssignment(
  state: ControlPlaneState,
  options: AssignmentSweepOptions = {},
): Promise<void> {
  try {
    await assignQueuedAndScheduledDurable(state, options);
  } catch {
    // Originating create/register/terminal/capacity paths must not fail closed.
  }
}

/**
 * Start assignment without occupying the caller's request. Browser REST must
 * use this (Invariant 12). When `onAssignmentRequested` is set (AWS REST), that
 * hook is the only work — typically `Lambda.invoke` Event of the cron function.
 * Locally, the in-process sweep starts and is not awaited.
 */
export async function enqueueAssignment(state: ControlPlaneState): Promise<void> {
  if (state.onAssignmentRequested) {
    await state.onAssignmentRequested();
    return;
  }
  void requestAssignment(state);
}
