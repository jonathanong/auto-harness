import type { HostInventoryRecord, RepositoryRecord } from "./db/plane-storage.ts";
import type {
  ArchiveObject,
  PublicSession,
  ScheduleRecord,
  WebhookDelivery,
} from "./control-plane-types.ts";
import { ControlPlaneCatalog } from "./control-plane-catalog-ext.ts";
import * as agentHosts from "./control-plane-agent-hosts.ts";
import * as agents from "./control-plane-agents.ts";
import * as lifecycle from "./control-plane-lifecycle.ts";
import * as repos from "./control-plane-repos.ts";
import * as schedules from "./control-plane-schedules.ts";

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
export class ControlPlane extends ControlPlaneCatalog {
  updateSchedule(
    id: string,
    patch: Partial<{
      name: string;
      providerAccountId: string;
      commandId: string;
      cron: string;
      timeout: number;
      nextRunAt: string;
      enabled: boolean;
      ref: string;
      repositoryId: string;
    }>,
  ): { ok: true; schedule: ScheduleRecord } | { ok: false; error: string } {
    return schedules.updateSchedule(this.state, id, patch);
  }

  deleteSchedule(id: string): { ok: true } | { ok: false; error: string } {
    return schedules.deleteSchedule(this.state, id);
  }

  triggerSchedule(
    id: string,
    nowIso: string = this.state.now(),
  ): { ok: true; session: PublicSession } | { ok: false; error: string } {
    return schedules.triggerSchedule(this.state, id, nowIso);
  }

  createRepository(input: {
    id?: string;
    name: string;
    url: string;
    defaultBranch?: string;
    setupScript?: string;
    terminalHookScript?: string;
  }): { ok: true; repository: RepositoryRecord } | { ok: false; error: string } {
    return repos.createRepository(this.state, input);
  }

  getRepository(id: string): RepositoryRecord | null {
    return repos.getRepository(this.state, id);
  }

  listRepositories(): RepositoryRecord[] {
    return repos.listRepositories(this.state);
  }

  updateRepository(
    id: string,
    patch: Partial<{
      name: string;
      url: string;
      defaultBranch: string;
      setupScript: string;
      terminalHookScript: string;
    }>,
  ): { ok: true; repository: RepositoryRecord } | { ok: false; error: string } {
    return repos.updateRepository(this.state, id, patch);
  }

  deleteRepository(id: string): { ok: true } | { ok: false; error: string } {
    return repos.deleteRepository(this.state, id);
  }

  cancelSession(id: string): { ok: true; session: PublicSession } | { ok: false; error: string } {
    return lifecycle.cancelSession(this.state, id);
  }

  evaluateCron(nowIso: string = this.state.now()): PublicSession[] {
    return schedules.evaluateCron(this.state, nowIso);
  }

  tryClaimScheduleFire(
    scheduleId: string,
    expectedNextRunAt: string,
    nowIso: string,
  ): PublicSession | null {
    return schedules.tryClaimScheduleFire(this.state, scheduleId, expectedNextRunAt, nowIso);
  }

  reclaimStaleHosts(nowMs: number = Date.now()): string[] {
    return lifecycle.reclaimStaleHosts(this.state, nowMs);
  }

  getHeartbeatStaleMs(): number {
    return this.state.heartbeatStaleMs;
  }

  getAckDeadlineMs(): number {
    return this.state.ackDeadlineMs;
  }

  getUsageLimitRetryCeiling(): number {
    return this.state.usageLimitRetryCeiling;
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

  putAgentHostConfig(
    hostId: string,
    body: unknown,
  ): { ok: true; config: HostInventoryRecord } | { ok: false; error: string } {
    return agentHosts.putAgentHostConfig(this.state, hostId, body);
  }

  getAgentHostConfig(hostId: string): HostInventoryRecord | null {
    return agentHosts.getAgentHostConfig(this.state, hostId);
  }

  listAgentHostConfigs(): HostInventoryRecord[] {
    return agentHosts.listAgentHostConfigs(this.state);
  }

  deleteAgentHostConfig(hostId: string): { ok: true } | { ok: false; error: string } {
    return agentHosts.deleteAgentHostConfig(this.state, hostId);
  }
}
