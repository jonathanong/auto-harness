import type { HostToServerMessage, HostWireMessage, SessionStatus } from "@auto-harness/shared";

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
import * as lifecycle from "./control-plane-lifecycle.ts";
import { listCommandProfiles } from "./control-plane-command-profiles.ts";
import * as messages from "./control-plane-messages.ts";
import * as schedules from "./control-plane-schedules.ts";
import * as sessions from "./control-plane-sessions.ts";
import * as worktrees from "./control-plane-worktrees.ts";
import * as reconnect from "./control-plane-reconnect.ts";

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

  setOnHostMessage(handler: ((hostId: string, msg: HostWireMessage) => void) | undefined): void {
    this.state.onHostMessage = handler;
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

  listHosts(): ReturnType<typeof agents.listHosts> {
    return agents.listHosts(this.state);
  }

  listCommandProfiles(): string[] {
    return listCommandProfiles(this.state);
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

  registerHost(opts: {
    hostId: string;
    worktrees: Array<{
      id: string;
      name: string;
      repositoryId: string;
      path: string;
      labels: string[];
    }>;
    commandProfiles: string[];
    replaceExisting?: boolean;
  }): { ok: true; connectionId: string } | { ok: false; error: string } {
    return agents.registerHost(this.state, opts);
  }

  disconnectHost(connectionId: string): string[] {
    return agents.disconnectHost(this.state, connectionId);
  }

  heartbeat(hostId: string, at?: string): boolean {
    return agents.heartbeat(this.state, hostId, at);
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

  async assignQueuedDurable(): Promise<
    Array<{ session: PublicSession; worktree: WorktreeRecord }>
  > {
    await reconnect.reclaimReconnectDeadlines(this.state, Date.now());
    return assign.assignQueuedDurable(this.state);
  }

  enforceAckDeadlines(nowMs: number = Date.now()): string[] {
    return assign.enforceAckDeadlines(this.state, nowMs);
  }

  async enforceAckDeadlinesDurable(nowMs: number = Date.now()): Promise<string[]> {
    return assign.enforceAckDeadlinesDurable(this.state, nowMs);
  }

  handleHostMessage(msg: HostToServerMessage): { ok: boolean; error?: string } {
    return messages.handleHostMessage(this.state, msg);
  }

  async handleHostMessageDurable(
    msg: HostToServerMessage,
    sourceConnectionId?: string,
    replaceExisting = false,
  ): Promise<Awaited<ReturnType<typeof messages.handleHostMessageDurable>>> {
    return messages.handleHostMessageDurable(this.state, msg, sourceConnectionId, replaceExisting);
  }

  async registerHostDurable(
    opts: Parameters<typeof agents.registerHost>[1],
  ): Promise<ReturnType<typeof agents.registerHost>> {
    return agents.registerHostDurable(this.state, opts);
  }

  async disconnectHostDurable(connectionId: string): Promise<string[]> {
    return agents.disconnectHostDurable(this.state, connectionId);
  }

  async reclaimReconnectDeadlines(nowMs: number = Date.now()): Promise<string[]> {
    return reconnect.reclaimReconnectDeadlines(this.state, nowMs);
  }

  async drainHostDurable(hostId: string): Promise<{ ok: boolean; runningSessionIds: string[] }> {
    return agents.drainHostDurable(this.state, hostId);
  }

  async reclaimStaleHostsDurable(nowMs: number = Date.now()): Promise<string[]> {
    return lifecycle.reclaimStaleHostsDurable(this.state, nowMs);
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
    providerAccountId?: string;
    commandId?: string;
    cron: string;
    timeout: number;
    nextRunAt: string;
    enabled?: boolean;
    ref?: string;
    id?: string;
  }): { ok: true; schedule: ScheduleRecord } | { ok: false; error: string } {
    return schedules.putSchedule(this.state, input);
  }

  getSchedule(id: string): ScheduleRecord | null {
    return schedules.getSchedule(this.state, id);
  }

  listSchedules(): ScheduleRecord[] {
    return schedules.listSchedules(this.state);
  }
}
