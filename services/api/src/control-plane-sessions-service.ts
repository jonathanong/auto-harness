import type { HostToServerMessage, SessionStatus } from "@auto-harness/shared";

import type {
  ArchiveMetadata,
  ArchiveObject,
  LogQuery,
  LogRecord,
  PublicSession,
} from "./control-plane-types.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";
import { toPublic } from "./control-plane-state.ts";
import * as assign from "./control-plane-assign.ts";
import { cancelSessionDurable } from "./control-plane-cancel-durable.ts";
import * as lifecycle from "./control-plane-lifecycle.ts";
import * as messages from "./control-plane-messages.ts";
import * as runningTimeout from "./control-plane-running-timeout.ts";
import * as clone from "./control-plane-session-clone.ts";
import * as sessions from "./control-plane-sessions.ts";
import * as durableSessions from "./control-plane-sessions-durable.ts";
import * as durableRuntime from "./control-plane-durable-read-runtime.ts";
import * as reconnect from "./control-plane-reconnect.ts";
import * as usage from "./control-plane-usage.ts";

function durableListRepositoryIds(
  requested: sessions.ListSessionsPageQuery,
): readonly string[] | undefined {
  if (!requested.repositoryId) return requested.scope?.repositoryIds;
  if (!requested.scope?.repositoryIds) return [requested.repositoryId];
  return requested.scope.repositoryIds.includes(requested.repositoryId)
    ? [requested.repositoryId]
    : [];
}

/** Session create/list/assign/resume/cancel and log/usage reads. */
export class ControlPlaneSessionsService {
  readonly state: ControlPlaneState;

  constructor(state: ControlPlaneState) {
    this.state = state;
  }

  createSession(
    body: unknown,
  ): { ok: true; session: PublicSession } | { ok: false; error: string; code?: string } {
    return sessions.createSession(this.state, body);
  }

  createSessionDurable(
    body: unknown,
    options: { principalId?: string } = {},
  ): Promise<Awaited<ReturnType<typeof durableSessions.createSessionDurable>>> {
    return durableSessions.createSessionDurable(this.state, body, options);
  }

  getSession(id: string): PublicSession | null {
    return sessions.getSession(this.state, id);
  }

  async getSessionDurable(id: string): Promise<PublicSession | null> {
    const session = await durableRuntime.getSessionDurable(this.state, id);
    return session ? toPublic(this.state, session) : null;
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

  async listSessionsPageDurable(
    query?: sessions.ListSessionsPageQuery,
  ): Promise<sessions.ListSessionsPageResult> {
    const requested = query ?? {};
    const repositoryIds = durableListRepositoryIds(requested);
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

  getLogsDurable(sessionId: string, query?: LogQuery): Promise<LogRecord[]> {
    return durableRuntime.getLogsDurable(this.state, sessionId, query);
  }

  assignQueued(): Array<{
    session: PublicSession;
    worktree: import("./db/types.ts").WorktreeRecord;
  }> {
    return assign.assignQueued(this.state);
  }

  async assignQueuedDurable(): Promise<
    Array<{ session: PublicSession; worktree: import("./db/types.ts").WorktreeRecord }>
  > {
    await reconnect.reclaimReconnectDeadlines(this.state, Date.now());
    return assign.assignQueuedDurable(this.state);
  }

  enforceAckDeadlines(nowMs: number = Date.now()): string[] {
    return assign.enforceAckDeadlines(this.state, nowMs);
  }

  enforceAckDeadlinesDurable(nowMs: number = Date.now()): Promise<string[]> {
    return assign.enforceAckDeadlinesDurable(this.state, nowMs);
  }

  enforceRunningTimeouts(nowMs: number = Date.now()): string[] {
    return runningTimeout.enforceRunningTimeouts(this.state, nowMs);
  }

  enforceRunningTimeoutsDurable(nowMs: number = Date.now()): Promise<string[]> {
    return runningTimeout.enforceRunningTimeoutsDurable(this.state, nowMs);
  }

  handleHostMessage(msg: HostToServerMessage): { ok: boolean; error?: string } {
    return messages.handleHostMessage(this.state, msg);
  }

  handleHostMessageDurable(
    msg: HostToServerMessage,
    sourceConnectionId?: string,
    replaceExisting = false,
  ): Promise<Awaited<ReturnType<typeof messages.handleHostMessageDurable>>> {
    return messages.handleHostMessageDurable(this.state, msg, sourceConnectionId, replaceExisting);
  }

  handlePendingHostMessageDurable(msg: HostToServerMessage, connectionId: string) {
    return messages.handleHostMessageDurable(this.state, msg, connectionId, true, true);
  }

  resumeSession(
    sessionId: string,
    opts: { pinExpiresAt?: string; prompt?: string; timeout?: number; priority?: number } = {},
  ): { ok: true; session: PublicSession; created: boolean } | { ok: false; error: string } {
    return sessions.resumeSession(this.state, sessionId, opts);
  }

  resumeSessionDurable(
    sessionId: string,
    opts: sessions.ResumeOptions = {},
  ): Promise<Awaited<ReturnType<typeof durableSessions.resumeSessionDurable>>> {
    return durableSessions.resumeSessionDurable(this.state, sessionId, opts);
  }

  cloneSession(
    sessionId: string,
    opts: clone.CloneOptions = {},
  ): ReturnType<typeof clone.cloneSession> {
    return clone.cloneSession(this.state, sessionId, opts);
  }

  cloneSessionDurable(
    sessionId: string,
    opts: clone.CloneOptions = {},
  ): Promise<Awaited<ReturnType<typeof durableSessions.cloneSessionDurable>>> {
    return durableSessions.cloneSessionDurable(this.state, sessionId, opts);
  }

  cancelSession(id: string): { ok: true; session: PublicSession } | { ok: false; error: string } {
    return lifecycle.cancelSession(this.state, id);
  }

  cancelSessionDurable(
    id: string,
  ): Promise<{ ok: true; session: PublicSession } | { ok: false; error: string }> {
    return cancelSessionDurable(this.state, id);
  }

  archiveSessionLogs(sessionId: string): Promise<ArchiveObject> {
    return lifecycle.archiveSessionLogs(this.state, sessionId);
  }

  getArchive(sessionId: string): ArchiveMetadata | null {
    return lifecycle.getArchive(this.state, sessionId);
  }

  listArchives(): ArchiveMetadata[] {
    return lifecycle.listArchives(this.state);
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
}
