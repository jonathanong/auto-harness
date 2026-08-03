import type { AgentHostRecord, RepositoryRecord } from "./db/plane-storage.ts";
import type {
  ArchiveObject,
  PublicSession,
  ScheduleRecord,
  WebhookDelivery,
} from "./control-plane-types.ts";
import { ControlPlaneBase } from "./control-plane-facade.ts";
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
export class ControlPlane extends ControlPlaneBase {
  updateSchedule(
    id: string,
    patch: Partial<{
      name: string;
      commandProfile: string;
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

  reclaimStaleAgents(nowMs: number = Date.now()): string[] {
    return lifecycle.reclaimStaleAgents(this.state, nowMs);
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

  drainAgent(agentId: string): { ok: boolean; runningSessionIds: string[] } {
    return agents.drainAgent(this.state, agentId);
  }

  isDraining(agentId: string): boolean {
    return agents.isDraining(this.state, agentId);
  }

  putAgentHostConfig(
    agentId: string,
    body: unknown,
  ): { ok: true; config: AgentHostRecord } | { ok: false; error: string } {
    return agentHosts.putAgentHostConfig(this.state, agentId, body);
  }

  getAgentHostConfig(agentId: string): AgentHostRecord | null {
    return agentHosts.getAgentHostConfig(this.state, agentId);
  }

  listAgentHostConfigs(): AgentHostRecord[] {
    return agentHosts.listAgentHostConfigs(this.state);
  }

  deleteAgentHostConfig(agentId: string): { ok: true } | { ok: false; error: string } {
    return agentHosts.deleteAgentHostConfig(this.state, agentId);
  }
}
