import type { AgentToServerMessage, AgentWireMessage, SessionStatus } from "@auto-harness/shared";

import type { WorktreeRecord } from "./db/types.ts";
import type {
  ControlPlaneOptions,
  LogRecord,
  PublicSession,
  ScheduleRecord,
} from "./control-plane-types.ts";
import {
  createControlPlaneState,
  hydrateFromStorage,
  settleStorage,
  type ControlPlaneState,
} from "./control-plane-state.ts";
import * as agents from "./control-plane-agents.ts";
import * as assign from "./control-plane-assign.ts";
import * as messages from "./control-plane-messages.ts";
import * as schedules from "./control-plane-schedules.ts";
import * as sessions from "./control-plane-sessions.ts";
import * as worktrees from "./control-plane-worktrees.ts";

/**
 * Shared ControlPlane implementation (methods split across facade + subclass
 * so each file stays under the max-lines budget).
 */
export class ControlPlaneBase {
  /** @internal Process cache — tests may inject edge-case map state. */
  readonly state: ControlPlaneState;

  constructor(options: ControlPlaneOptions = {}) {
    this.state = createControlPlaneState(options);
  }

  setOnAgentMessage(handler: ((agentId: string, msg: AgentWireMessage) => void) | undefined): void {
    this.state.onAgentMessage = handler;
  }

  async hydrateFromStorage(): Promise<void> {
    await hydrateFromStorage(this.state);
  }

  async settleStorage(): Promise<void> {
    await settleStorage(this.state);
  }

  setWebhookUrl(url: string | null): void {
    this.state.webhookUrl = url;
  }

  seedWorktree(record: WorktreeRecord): void {
    worktrees.seedWorktree(this.state, record);
  }

  listWorktrees(): WorktreeRecord[] {
    return worktrees.listWorktrees(this.state);
  }

  getWorktree(id: string): WorktreeRecord | null {
    return worktrees.getWorktree(this.state, id);
  }

  listAgents(): ReturnType<typeof agents.listAgents> {
    return agents.listAgents(this.state);
  }

  listCommandProfiles(): string[] {
    return agents.listCommandProfiles(this.state);
  }

  createSession(
    body: unknown,
  ): { ok: true; session: PublicSession } | { ok: false; error: string; code?: string } {
    return sessions.createSession(this.state, body);
  }

  getSession(id: string): PublicSession | null {
    return sessions.getSession(this.state, id);
  }

  forceStatus(id: string, status: SessionStatus): PublicSession | null {
    return sessions.forceStatus(this.state, id, status);
  }

  listSessions(): PublicSession[] {
    return sessions.listSessions(this.state);
  }

  listSessionsPage(query?: sessions.ListSessionsPageQuery): sessions.ListSessionsPageResult {
    return sessions.listSessionsPage(this.state, query ?? {});
  }

  registerAgent(opts: {
    agentId: string;
    worktrees: Array<{ id: string; repositoryId: string; path: string; labels: string[] }>;
    commandProfiles: string[];
    replaceExisting?: boolean;
  }): { ok: true; connectionId: string } | { ok: false; error: string } {
    return agents.registerAgent(this.state, opts);
  }

  disconnectAgent(connectionId: string): string[] {
    return agents.disconnectAgent(this.state, connectionId);
  }

  heartbeat(agentId: string, at?: string): boolean {
    return agents.heartbeat(this.state, agentId, at);
  }

  appendLog(opts: {
    sessionId: string;
    stream: string;
    content: string;
    timestamp: string;
    seq: number;
  }): LogRecord {
    return messages.appendLog(this.state, opts);
  }

  getLogs(sessionId: string): LogRecord[] {
    return messages.getLogs(this.state, sessionId);
  }

  assignQueued(): Array<{ session: PublicSession; worktree: WorktreeRecord }> {
    return assign.assignQueued(this.state);
  }

  enforceAckDeadlines(nowMs: number = Date.now()): string[] {
    return assign.enforceAckDeadlines(this.state, nowMs);
  }

  handleAgentMessage(msg: AgentToServerMessage): { ok: boolean; error?: string } {
    return messages.handleAgentMessage(this.state, msg);
  }

  resumeSession(
    sessionId: string,
    opts: { pinExpiresAt?: string } = {},
  ): { ok: true; session: PublicSession } | { ok: false; error: string } {
    return sessions.resumeSession(this.state, sessionId, opts);
  }

  putSchedule(input: {
    repositoryId: string;
    name: string;
    commandProfile: string;
    cron: string;
    timeout: number;
    nextRunAt: string;
    enabled?: boolean;
    ref?: string;
    id?: string;
  }): ScheduleRecord {
    return schedules.putSchedule(this.state, input);
  }

  getSchedule(id: string): ScheduleRecord | null {
    return schedules.getSchedule(this.state, id);
  }

  listSchedules(): ScheduleRecord[] {
    return schedules.listSchedules(this.state);
  }
}
