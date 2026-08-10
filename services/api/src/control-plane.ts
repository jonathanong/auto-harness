import type { ArchiveObject, PublicSession, WebhookDelivery } from "./control-plane-types.ts";
import { ControlPlaneManagement } from "./control-plane-management-ext.ts";
import * as agents from "./control-plane-agents.ts";
import { cancelSessionDurable } from "./control-plane-cancel-durable.ts";
import * as lifecycle from "./control-plane-lifecycle.ts";
import * as schedules from "./control-plane-schedules.ts";
import * as scheduledAssign from "./control-plane-scheduled-assign.ts";

export type {
  ArchiveObject,
  ConnectionRecord,
  ControlPlaneOptions,
  LogRecord,
  PublicSession,
  ScheduleRecord,
  WebhookDelivery,
} from "./control-plane-types.ts";

/**
 * Control plane for Phases 2–5 (invariants 1–9).
 * Prefer {@link createControlPlane} so state is backed by DynamoDB Local / AWS.
 * Working-set Maps are a process cache; durable truth is DynamoDB when `storage` is set.
 */
export class ControlPlane extends ControlPlaneManagement {
  async assignScheduledQueuedDurable(): Promise<
    Array<{ session: PublicSession; hostId: string; worktreeId: null }>
  > {
    await this.reclaimReconnectDeadlines(Date.now());
    return scheduledAssign.assignScheduledQueuedDurable(this.state);
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
    { ok: true; session: PublicSession; created: boolean } | { ok: false; error: string }
  > {
    const result = await schedules.triggerScheduleDurable(this.state, id, nowIso);
    if (result.ok) await this.assignScheduledQueuedDurable();
    return result;
  }

  cancelSession(id: string): { ok: true; session: PublicSession } | { ok: false; error: string } {
    return lifecycle.cancelSession(this.state, id);
  }

  async cancelSessionDurable(
    id: string,
  ): Promise<{ ok: true; session: PublicSession } | { ok: false; error: string }> {
    return cancelSessionDurable(this.state, id);
  }

  evaluateCron(nowIso: string = this.state.now()): PublicSession[] {
    return schedules.evaluateCron(this.state, nowIso);
  }

  async evaluateCronDurable(nowIso: string = this.state.now()): Promise<PublicSession[]> {
    const sessions = await schedules.evaluateCronDurable(this.state, nowIso);
    if (sessions.length) await this.assignScheduledQueuedDurable();
    return sessions;
  }

  tryClaimScheduleFire(
    scheduleId: string,
    expectedNextRunAt: string,
    nowIso: string,
  ): PublicSession | null {
    return schedules.tryClaimScheduleFire(this.state, scheduleId, expectedNextRunAt, nowIso);
  }

  async tryClaimScheduleFireDurable(
    scheduleId: string,
    expectedNextRunAt: string,
    nowIso: string,
  ): Promise<PublicSession | null> {
    return schedules.tryClaimScheduleFireDurable(this.state, scheduleId, expectedNextRunAt, nowIso);
  }

  reclaimStaleHosts(nowMs: number = Date.now()): string[] {
    return lifecycle.reclaimStaleHosts(this.state, nowMs);
  }

  override async reclaimStaleHostsDurable(nowMs: number = Date.now()): Promise<string[]> {
    return lifecycle.reclaimStaleHostsDurable(this.state, nowMs);
  }

  getHeartbeatStaleMs(): number {
    return this.state.heartbeatStaleMs;
  }

  getAckDeadlineMs(): number {
    return this.state.ackDeadlineMs;
  }

  archiveSessionLogs(sessionId: string): ArchiveObject | null {
    return lifecycle.archiveSessionLogs(this.state, sessionId);
  }

  getArchive(sessionId: string): ArchiveObject | null {
    return lifecycle.getArchive(this.state, sessionId);
  }

  listArchives(): ArchiveObject[] {
    return lifecycle.listArchives(this.state);
  }

  listWebhookDeliveries(): WebhookDelivery[] {
    return lifecycle.listWebhookDeliveries(this.state);
  }

  drainHost(hostId: string): { ok: boolean; runningSessionIds: string[] } {
    return agents.drainHost(this.state, hostId);
  }

  isDraining(hostId: string): boolean {
    return agents.isDraining(this.state, hostId);
  }
}
