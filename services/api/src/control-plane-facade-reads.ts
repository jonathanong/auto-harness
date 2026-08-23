import type { WorktreeRecord } from "./db/types.ts";
import type { LogQuery, LogRecord, PublicSession, ScheduleRecord } from "./control-plane-types.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";
import { toPublic } from "./control-plane-state.ts";
import * as agents from "./control-plane-agents.ts";
import * as durableCatalog from "./control-plane-durable-read-catalog.ts";
import * as durableRuntime from "./control-plane-durable-read-runtime.ts";
import * as schedules from "./control-plane-schedules.ts";
import * as sessions from "./control-plane-sessions.ts";
import { ControlPlaneAuditFacade } from "./control-plane-audit-facade.ts";
import * as usage from "./control-plane-usage.ts";

function indexUnavailable(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: unknown }).name === "ValidationException" &&
    "message" in error &&
    typeof (error as { message?: unknown }).message === "string" &&
    /index|backfill/i.test((error as { message: string }).message)
  );
}

async function repositoryWorktreeCounts(
  state: ControlPlaneState,
  repositoryIds: readonly string[],
  hostId?: string,
): Promise<number[]> {
  const storage = state.storage;
  if (storage && typeof storage.countWorktreesByRepository === "function") {
    try {
      return await Promise.all(
        repositoryIds.map((repositoryId) =>
          storage.countWorktreesByRepository(repositoryId, hostId),
        ),
      );
    } catch (error) {
      if (!indexUnavailable(error)) throw error;
    }
  }
  const records = await durableRuntime.listWorktreesDurable(state);
  return repositoryIds.map(
    (repositoryId) =>
      records.filter(
        (worktree) =>
          worktree.repositoryId === repositoryId && (!hostId || worktree.hostId === hostId),
      ).length,
  );
}

async function repositorySessionCounts(
  state: ControlPlaneState,
  repositoryIds: readonly string[],
  hostId?: string,
): Promise<number[]> {
  if (state.storage) {
    try {
      return await Promise.all(
        repositoryIds.map((repositoryId) =>
          state.storage!.countSessionsByRepository(repositoryId, hostId),
        ),
      );
    } catch (error) {
      if (!indexUnavailable(error)) throw error;
    }
  }
  const records = state.storage
    ? await durableRuntime.listSessionsDurable(state)
    : [...state.sessions.values()];
  return repositoryIds.map(
    (repositoryId) =>
      records.filter(
        (session) =>
          session.repositoryId === repositoryId && (!hostId || session.hostId === hostId),
      ).length,
  );
}

async function repositoryScheduleCounts(
  state: ControlPlaneState,
  repositoryIds: readonly string[],
): Promise<number[]> {
  const storage = state.storage;
  if (storage && typeof storage.countSchedulesByRepository === "function") {
    try {
      return await Promise.all(
        repositoryIds.map((repositoryId) => storage.countSchedulesByRepository(repositoryId)),
      );
    } catch (error) {
      if (!indexUnavailable(error)) throw error;
    }
  }
  const records = await durableCatalog.listSchedulesDurable(state);
  return repositoryIds.map(
    (repositoryId) => records.filter((schedule) => schedule.repositoryId === repositoryId).length,
  );
}

/** Durable read-through facade kept separate from mutation-heavy base methods. */
export class ControlPlaneReadFacade extends ControlPlaneAuditFacade {
  async listRepositoryCountsDurable(
    repositoryIds: readonly string[],
    hostId?: string,
  ): Promise<Map<string, { sessionCount: number; worktreeCount: number; scheduleCount: number }>> {
    const counts = new Map(
      repositoryIds.map((id) => [id, { sessionCount: 0, worktreeCount: 0, scheduleCount: 0 }]),
    );
    if (repositoryIds.length === 0) return counts;
    const [sessionCounts, worktreeCounts, scheduleCounts] = await Promise.all([
      repositorySessionCounts(this.state, repositoryIds, hostId),
      repositoryWorktreeCounts(this.state, repositoryIds, hostId),
      repositoryScheduleCounts(this.state, repositoryIds),
    ]);
    repositoryIds.forEach((repositoryId, index) => {
      const count = counts.get(repositoryId)!;
      count.sessionCount = sessionCounts[index] ?? 0;
      count.worktreeCount = worktreeCounts[index] ?? 0;
      count.scheduleCount = scheduleCounts[index] ?? 0;
    });
    return counts;
  }

  async refreshSchedulerReadModelDurable(): Promise<void> {
    await durableRuntime.refreshSchedulerReadModel(this.state);
  }

  async listWorktreesDurable(): Promise<WorktreeRecord[]> {
    return durableRuntime.listWorktreesDurable(this.state);
  }

  async listHostsDurable(): Promise<ReturnType<typeof agents.listHosts>> {
    await durableRuntime.refreshSchedulerReadModel(this.state);
    await durableRuntime.listWorktreesDurable(this.state);
    return agents.listHosts(this.state);
  }

  override async getSessionDurable(id: string): Promise<PublicSession | null> {
    const session = await durableRuntime.getSessionDurable(this.state, id);
    return session ? toPublic(this.state, session) : null;
  }

  async listSessionsPageDurable(
    query?: sessions.ListSessionsPageQuery,
  ): Promise<sessions.ListSessionsPageResult> {
    const requested = query ?? {};
    const repositoryIds = requested.repositoryId
      ? requested.scope?.repositoryIds
        ? requested.scope.repositoryIds.includes(requested.repositoryId)
          ? [requested.repositoryId]
          : []
        : [requested.repositoryId]
      : requested.scope?.repositoryIds;
    if (repositoryIds !== undefined) {
      const records = await durableRuntime.listSessionsForRepositoriesDurable(
        this.state,
        repositoryIds,
      );
      return sessions.listSessionsPage(this.state, requested, records);
    }
    const records = await durableRuntime.listSessionsDurable(this.state);
    return sessions.listSessionsPage(this.state, requested, records);
  }

  async getLogsDurable(sessionId: string, query?: LogQuery): Promise<LogRecord[]> {
    return durableRuntime.getLogsDurable(this.state, sessionId, query);
  }

  async getUsageDurable(sessionId?: string): Promise<ReturnType<typeof usage.usageRecords>> {
    if (this.state.storage && typeof this.state.storage.listUsageRecords === "function") {
      const records = await this.state.storage.listUsageRecords(sessionId);
      for (const record of records)
        this.state.usageRecords.set(
          `${record.sessionId}\0${record.attemptId}\0${record.sequence}`,
          record,
        );
    }
    return usage.usageRecords(this.state, sessionId);
  }

  async getUsageAggregateDurable(
    sessionId?: string,
  ): Promise<ReturnType<typeof usage.usageAggregate>> {
    return usage.aggregateUsage(await this.getUsageDurable(sessionId));
  }

  async getScheduleDurable(id: string): Promise<ScheduleRecord | null> {
    const schedule = await durableCatalog.getScheduleDurable(this.state, id);
    if (schedule) await durableRuntime.listSessionsDurable(this.state);
    return schedule ? schedules.getSchedule(this.state, schedule.id) : null;
  }

  async listSchedulesDurable(): Promise<ScheduleRecord[]> {
    await Promise.all([
      durableCatalog.listSchedulesDurable(this.state),
      durableRuntime.listSessionsDurable(this.state),
    ]);
    return schedules.listSchedules(this.state);
  }
}
