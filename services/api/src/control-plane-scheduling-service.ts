import type { PublicSession, ScheduleRecord } from "./control-plane-types.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";
import * as schedules from "./control-plane-schedules.ts";
import { updateScheduleDurable } from "./control-plane-schedules-durable.ts";
import * as scheduledAssign from "./control-plane-scheduled-assign.ts";
import * as durableCatalog from "./control-plane-durable-read-catalog.ts";
import * as durableRuntime from "./control-plane-durable-read-runtime.ts";
import * as reconnect from "./control-plane-reconnect.ts";

/** Schedule CRUD, cron fire, and scheduled assignment. */
export class ControlPlaneSchedulingService {
  constructor(readonly state: ControlPlaneState) {}

  putSchedule(
    input: Parameters<typeof schedules.putSchedule>[1],
  ): ReturnType<typeof schedules.putSchedule> {
    return schedules.putSchedule(this.state, input);
  }

  putScheduleDurable(
    input: Parameters<typeof schedules.putSchedule>[1],
  ): Promise<ReturnType<typeof schedules.putSchedule>> {
    return schedules.putScheduleDurable(this.state, input);
  }

  updateSchedule(
    id: string,
    patch: Parameters<typeof schedules.updateSchedule>[2],
  ): ReturnType<typeof schedules.updateSchedule> {
    return schedules.updateSchedule(this.state, id, patch);
  }

  updateScheduleDurable(
    id: string,
    patch: Parameters<typeof schedules.updateSchedule>[2],
  ): Promise<ReturnType<typeof schedules.updateSchedule>> {
    return updateScheduleDurable(this.state, id, patch);
  }

  deleteSchedule(id: string): ReturnType<typeof schedules.deleteSchedule> {
    return schedules.deleteSchedule(this.state, id);
  }

  deleteScheduleDurable(id: string): Promise<ReturnType<typeof schedules.deleteSchedule>> {
    return schedules.deleteScheduleDurable(this.state, id);
  }

  triggerSchedule(
    id: string,
    nowIso: string = this.state.now(),
  ): { ok: true; session: PublicSession; created: boolean } | { ok: false; error: string } {
    return schedules.triggerSchedule(this.state, id, nowIso);
  }

  async triggerScheduleDurable(
    id: string,
    nowIso: string = this.state.now(),
  ): Promise<
    | { ok: true; session: PublicSession; created: boolean }
    | { ok: false; error: string; code?: "DRAINING" | undefined; operationId?: string | undefined }
  > {
    const result = await schedules.triggerScheduleDurable(this.state, id, nowIso);
    if (result.ok) await this.assignScheduledQueuedDurable();
    return result;
  }

  getSchedule(id: string): ScheduleRecord | null {
    return schedules.getSchedule(this.state, id);
  }

  async getScheduleDurable(id: string): Promise<ScheduleRecord | null> {
    const schedule = await durableCatalog.getScheduleDurable(this.state, id);
    if (schedule) await durableRuntime.listSessionsDurable(this.state);
    return schedule ? schedules.getSchedule(this.state, schedule.id) : null;
  }

  listSchedules(): ScheduleRecord[] {
    return schedules.listSchedules(this.state);
  }

  async listSchedulesDurable(): Promise<ScheduleRecord[]> {
    await Promise.all([
      durableCatalog.listSchedulesDurable(this.state),
      durableRuntime.listSessionsDurable(this.state),
    ]);
    return schedules.listSchedules(this.state);
  }

  evaluateCron(nowIso: string = this.state.now()): PublicSession[] {
    return schedules.evaluateCron(this.state, nowIso);
  }

  async evaluateCronDurable(nowIso: string = this.state.now()): Promise<PublicSession[]> {
    const created = await schedules.evaluateCronDurable(this.state, nowIso);
    if (created.length) await this.assignScheduledQueuedDurable();
    return created;
  }

  tryClaimScheduleFire(
    scheduleId: string,
    expectedNextRunAt: string,
    nowIso: string,
  ): PublicSession | null {
    return schedules.tryClaimScheduleFire(this.state, scheduleId, expectedNextRunAt, nowIso);
  }

  tryClaimScheduleFireDurable(
    scheduleId: string,
    expectedNextRunAt: string,
    nowIso: string,
  ): Promise<PublicSession | null> {
    return schedules.tryClaimScheduleFireDurable(this.state, scheduleId, expectedNextRunAt, nowIso);
  }

  async assignScheduledQueuedDurable(): Promise<
    Array<{ session: PublicSession; hostId: string; worktreeId: null }>
  > {
    await reconnect.reclaimReconnectDeadlines(this.state, Date.now());
    return scheduledAssign.assignScheduledQueuedDurable(this.state);
  }

  refreshSchedulerReadModelDurable(): Promise<void> {
    return durableRuntime.refreshSchedulerReadModel(this.state);
  }
}
