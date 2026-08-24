import {
  HOST_PROTOCOL_VERSION,
  type HostToServerMessage,
  type HostWireMessage,
  type SessionStatus,
} from "@auto-harness/shared";

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
import * as messages from "./control-plane-messages.ts";
import * as schedules from "./control-plane-schedules.ts";
import * as sessions from "./control-plane-sessions.ts";
import * as durableSessions from "./control-plane-sessions-durable.ts";
import * as worktrees from "./control-plane-worktrees.ts";
import * as reconnect from "./control-plane-reconnect.ts";
import * as runningTimeout from "./control-plane-running-timeout.ts";
import { ensureSeededTestHost, testHostRuntime } from "./control-plane-test-host.ts";

export class ControlPlaneBase {
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

  seedWorktree(record: WorktreeRecord): void {
    ensureSeededTestHost(this.state, record);
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

  createSession(
    body: unknown,
  ): { ok: true; session: PublicSession } | { ok: false; error: string; code?: string } {
    return sessions.createSession(this.state, body);
  }

  async createSessionDurable(
    body: unknown,
    options: { principalId?: string } = {},
  ): Promise<Awaited<ReturnType<typeof durableSessions.createSessionDurable>>> {
    return durableSessions.createSessionDurable(this.state, body, options);
  }

  getSession(id: string): PublicSession | null {
    return sessions.getSession(this.state, id);
  }

  async getSessionDurable(id: string): Promise<PublicSession | null> {
    return durableSessions.getSessionDurable(this.state, id);
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

  registerHost(
    opts: Parameters<typeof agents.registerHost>[1],
  ): { ok: true; connectionId: string } | { ok: false; error: string } {
    return agents.registerHost(this.state, {
      ...opts,
      runtime: testHostRuntime(opts.runtime),
      protocolVersion: opts.protocolVersion ?? HOST_PROTOCOL_VERSION,
    });
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

  enforceRunningTimeouts(nowMs: number = Date.now()): string[] {
    return runningTimeout.enforceRunningTimeouts(this.state, nowMs);
  }

  async enforceRunningTimeoutsDurable(nowMs: number = Date.now()): Promise<string[]> {
    return runningTimeout.enforceRunningTimeoutsDurable(this.state, nowMs);
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
    return agents.registerHostDurable(this.state, {
      ...opts,
      runtime: testHostRuntime(opts.runtime),
      protocolVersion: opts.protocolVersion ?? HOST_PROTOCOL_VERSION,
    });
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
    opts: { pinExpiresAt?: string; prompt?: string; timeout?: number; priority?: number } = {},
  ): { ok: true; session: PublicSession; created: boolean } | { ok: false; error: string } {
    return sessions.resumeSession(this.state, sessionId, opts);
  }

  async resumeSessionDurable(
    sessionId: string,
    opts: sessions.ResumeOptions = {},
  ): Promise<Awaited<ReturnType<typeof durableSessions.resumeSessionDurable>>> {
    return durableSessions.resumeSessionDurable(this.state, sessionId, opts);
  }
  putSchedule(input: {
    repositoryId: string;
    name: string;
    target: unknown;
    fallbacks?: unknown;
    cron: string;
    timeout: number;
    queueTtlSeconds?: number;
    nextRunAt?: string;
    enabled?: boolean;
    ref?: string;
    concurrencyId?: string;
    prompt?: string;
    id?: string;
  }): { ok: true; schedule: ScheduleRecord } | { ok: false; error: string } {
    return schedules.putSchedule(this.state, input);
  }
}
