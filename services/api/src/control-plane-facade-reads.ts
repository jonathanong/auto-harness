import type { WorktreeRecord } from "./db/types.ts";
import type { LogQuery, LogRecord, PublicSession, ScheduleRecord } from "./control-plane-types.ts";
import { toPublic } from "./control-plane-state.ts";
import * as agents from "./control-plane-agents.ts";
import { listCommandProfiles } from "./control-plane-command-profiles.ts";
import * as durableCatalog from "./control-plane-durable-read-catalog.ts";
import * as durableRuntime from "./control-plane-durable-read-runtime.ts";
import * as schedules from "./control-plane-schedules.ts";
import * as sessions from "./control-plane-sessions.ts";
import { ControlPlaneBase } from "./control-plane-facade.ts";

/** Durable read-through facade kept separate from mutation-heavy base methods. */
export class ControlPlaneReadFacade extends ControlPlaneBase {
  async listWorktreesDurable(): Promise<WorktreeRecord[]> {
    return durableRuntime.listWorktreesDurable(this.state);
  }

  async listHostsDurable(): Promise<ReturnType<typeof agents.listHosts>> {
    await durableRuntime.refreshSchedulerReadModel(this.state);
    await durableRuntime.listWorktreesDurable(this.state);
    return agents.listHosts(this.state);
  }

  async listCommandProfilesDurable(): Promise<string[]> {
    await durableRuntime.refreshSchedulerReadModel(this.state);
    await durableRuntime.listWorktreesDurable(this.state);
    return listCommandProfiles(this.state);
  }

  async getSessionDurable(id: string): Promise<PublicSession | null> {
    const session = await durableRuntime.getSessionDurable(this.state, id);
    return session ? toPublic(this.state, session) : null;
  }

  async listSessionsPageDurable(
    query?: sessions.ListSessionsPageQuery,
  ): Promise<sessions.ListSessionsPageResult> {
    await durableRuntime.listSessionsDurable(this.state);
    return sessions.listSessionsPage(this.state, query ?? {});
  }

  async getLogsDurable(sessionId: string, query?: LogQuery): Promise<LogRecord[]> {
    return durableRuntime.getLogsDurable(this.state, sessionId, query);
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
