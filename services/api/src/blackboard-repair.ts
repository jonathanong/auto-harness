import { randomUUID } from "node:crypto";
import type { ControlPlaneState } from "./control-plane-state.ts";
import { enqueueBlackboardSession } from "./blackboard-lifecycle.ts";
import type { SessionListPageQuery } from "./db/plane-storage-sessions-list-page.ts";

/** One indexed page per terminal status; durable leased cursors survive stream-retention outages. */
export async function repairBlackboardReporting(
  state: ControlPlaneState,
  canContinue: () => boolean = () => true,
): Promise<void> {
  const storage = state.storage;
  if (!storage || !state.blackboardReporting) return;
  for (const status of ["completed", "failed", "cancelled", "timed_out"] as const) {
    if (!canContinue()) return;
    const checkpoint = await storage.claimReportingRepair(status, randomUUID(), state.now());
    if (!checkpoint) continue;
    const query: SessionListPageQuery = {
      status,
      sort: "oldest",
      limit: 20,
      shardCount: state.shardCount,
      repositoryId: null,
      repositoryIds: null,
      hostId: null,
      source: null,
      concurrencyId: null,
      scheduleId: null,
    };
    const pageQuery = checkpoint.cursor
      ? {
          ...query,
          continuation: {
            version: 2 as const,
            sort: query.sort,
            query: {
              repositoryId: null,
              status,
              hostId: null,
              concurrencyId: null,
              scheduleId: null,
              source: null,
            },
            scopeHash: "reporting-repair",
            partitions: checkpoint.cursor,
          },
        }
      : query;
    let page;
    try {
      page = await storage.listSessionsPage(pageQuery);
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "InvalidSessionCursorError") throw error;
      // A changed shard count/index contract restarts at the beginning.
      page = await storage.listSessionsPage(query);
    }
    for (const indexed of page.items) {
      const current = await storage.getSession(indexed.id, true);
      if (current?.status === status) await enqueueBlackboardSession(state, current);
    }
    await storage.completeReportingRepair(checkpoint, page.continuation, state.now());
  }
}
