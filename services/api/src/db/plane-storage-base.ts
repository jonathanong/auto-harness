/* eslint-disable max-lines */
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { SessionStatus } from "@auto-harness/shared";
import type { SessionResumeSpec } from "@auto-harness/shared";

import type { DynamoTableNames } from "./dynamo.ts";
import type { SessionRecord, WorktreeRecord } from "./types.ts";
import {
  type HostInventoryRecord,
  type ArchiveObject,
  type ConnectionRecord,
  type AuthAccountRecord,
  type LogRecord,
  type PlaneStorageCtx,
  type RepositoryRecord,
  type ScheduleRecord,
} from "./plane-storage-types.ts";
import * as sessions from "./plane-storage-sessions.ts";
import * as reconnect from "./plane-storage-reconnect.ts";
import * as reconnectRollback from "./plane-storage-reconnect-rollback.ts";
import * as locks from "./plane-storage-locks.ts";
import * as catalog from "./plane-storage-catalog.ts";
import * as auth from "./plane-storage-auth.ts";

/**
 * Sessions/worktrees/locks/schedules/repositories/archives/agent-hosts delegators.
 * Split from DynamoPlaneStorage so each file stays under the max-lines budget —
 * mirrors the ControlPlaneBase/ControlPlane split in control-plane-facade.ts.
 */
export class DynamoPlaneStorageBase {
  protected readonly ctx: PlaneStorageCtx;

  constructor(doc: DynamoDBDocumentClient, tables: DynamoTableNames) {
    this.ctx = { doc, tables };
  }

  putSession(session: SessionRecord): Promise<void> {
    return sessions.putSession(this.ctx, session);
  }

  createSession(session: SessionRecord): Promise<sessions.CreateSessionResult> {
    return sessions.createSession(this.ctx, session);
  }

  releaseConcurrencyLock(concurrencyId: string, sessionId: string): Promise<void> {
    return sessions.releaseConcurrencyLock(this.ctx, concurrencyId, sessionId);
  }

  getSession(id: string): Promise<SessionRecord | null> {
    return sessions.getSession(this.ctx, id);
  }

  listAllSessions(): Promise<SessionRecord[]> {
    return sessions.listAllSessions(this.ctx);
  }

  async listSessionsByHost(hostId: string): Promise<SessionRecord[]> {
    return (await sessions.listAllSessions(this.ctx)).filter(
      (session) => session.hostId === hostId,
    );
  }

  listSessionsByStatus(status: SessionStatus, shard: number): Promise<SessionRecord[]> {
    return sessions.listSessionsByStatus(this.ctx, status, shard);
  }

  putWorktree(wt: WorktreeRecord): Promise<void> {
    return sessions.putWorktree(this.ctx, wt);
  }

  putWorktreeFenced(
    wt: WorktreeRecord,
    fence: { hostId: string; connectionId: string },
  ): Promise<boolean> {
    return sessions.putWorktreeFenced(this.ctx, wt, fence);
  }

  getWorktree(id: string): Promise<WorktreeRecord | null> {
    return sessions.getWorktree(this.ctx, id);
  }

  listAllWorktrees(): Promise<WorktreeRecord[]> {
    return sessions.listAllWorktrees(this.ctx);
  }

  async listWorktreesByHost(hostId: string): Promise<WorktreeRecord[]> {
    return (await sessions.listAllWorktrees(this.ctx)).filter(
      (worktree) => worktree.hostId === hostId,
    );
  }

  listWorktreesForRepo(repositoryId: string): Promise<WorktreeRecord[]> {
    return sessions.listWorktreesForRepo(this.ctx, repositoryId);
  }

  tryClaimWorktree(opts: { worktreeId: string; sessionId: string; now: string }): Promise<boolean> {
    return sessions.tryClaimWorktree(this.ctx, opts);
  }

  tryAssignSession(opts: {
    sessionId: string;
    worktreeId: string;
    hostId: string;
    connectionId: string;
    now: string;
    attemptId: string;
    resolvedArgv: string[];
    resumeSpec?: SessionResumeSpec;
    resolvedRoute: SessionRecord["resolvedRoute"];
    providerAccountId?: string;
    queueShard: number;
  }): Promise<boolean> {
    return sessions.tryAssignSession(this.ctx, opts);
  }

  failExpiredResumeSession(opts: {
    sessionId: string;
    queueShard: number;
    pinExpiresAt: string;
    concurrencyId?: string;
  }): Promise<boolean> {
    return sessions.failExpiredResumeSession(this.ctx, opts);
  }

  clearResumePin(opts: {
    sessionId: string;
    pinnedHostId: string;
    pinExpiresAt?: string;
  }): Promise<boolean> {
    return sessions.clearResumePin(this.ctx, opts);
  }

  expireQueuedSession(opts: {
    sessionId: string;
    queueShard: number;
    queueExpiresAt: string;
    completedAt: string;
  }): Promise<boolean> {
    return sessions.expireQueuedSession(this.ctx, opts);
  }

  releaseCancelledSessionWorktree(opts: {
    sessionId: string;
    worktreeId: string;
    /** Terminal reports from a live daemon preserve reachability; disconnect
     * cleanup deliberately sets this false. Make the distinction explicit at
     * every callsite instead of deriving it from the terminal session. */
    online: boolean;
    cliResumeRef?: string;
    fence?: { hostId: string; connectionId: string };
    attemptId: string;
    concurrencyId?: string;
  }): Promise<boolean> {
    return sessions.releaseCancelledSessionWorktree(this.ctx, opts);
  }

  tryRequeueSession(opts: {
    sessionId: string;
    worktreeId: string;
    attemptId: string;
    queueShard: number;
    reason?: string;
    forceOffline?: boolean;
    expectedHostId?: string;
    expectedReconnectDeadlineAt?: string;
    expectedConnectionId?: string;
    nextConnectionId?: string;
    requireNoHostLock?: string;
    fence?: { hostId: string; connectionId: string };
    requireUnacknowledged?: boolean;
  }): Promise<boolean> {
    return sessions.tryRequeueSession(this.ctx, opts);
  }

  markReconnectPending(opts: {
    sessionId: string;
    hostId: string;
    worktreeId: string;
    deadlineAt: string;
    connectionId: string;
  }): Promise<boolean> {
    return reconnect.markReconnectPending(this.ctx, opts);
  }

  confirmReconnect(opts: {
    sessionId: string;
    hostId: string;
    worktreeId: string;
    deadlineAt?: string;
    connectionId: string;
  }): Promise<boolean> {
    return reconnect.confirmReconnect(this.ctx, opts);
  }

  restoreReconnectPending(opts: {
    sessionId: string;
    hostId: string;
    worktreeId: string;
    connectionId: string;
    previousDeadlineAt?: string;
    previousAssignmentConnectionId?: string;
    previousWorktreeConnectionId?: string;
  }): Promise<boolean> {
    return reconnectRollback.restoreReconnectPending(this.ctx, opts);
  }

  requeueUsageLimitedSession(opts: {
    sessionId: string;
    worktreeId: string;
    attemptId: string;
    providerAccountId: string;
    queueShard: number;
    now: string;
    usageLimitedUntil: string;
    errorMessage?: string;
  }): Promise<boolean> {
    return sessions.requeueUsageLimitedSession(this.ctx, opts);
  }

  suppressProviderlessUsageLimit(opts: {
    sessionId: string;
    worktreeId: string;
    attemptId: string;
    queueShard: number;
    targetIndex: number;
    errorMessage?: string;
  }): Promise<boolean> {
    return sessions.suppressProviderlessUsageLimit(this.ctx, opts);
  }

  acknowledgeSession(
    sessionId: string,
    acknowledgedAt: string,
    fence?: { hostId: string; connectionId: string },
  ): Promise<boolean>;
  acknowledgeSession(opts: {
    sessionId: string;
    worktreeId: string;
    attemptId: string;
    acknowledgedAt: string;
  }): Promise<boolean>;
  acknowledgeSession(
    arg:
      | string
      | { sessionId: string; worktreeId: string; attemptId: string; acknowledgedAt: string },
    acknowledgedAtOrFence?: string | { hostId: string; connectionId: string },
    fence?: { hostId: string; connectionId: string },
  ): Promise<boolean> {
    if (typeof arg === "string") {
      return sessions.acknowledgeSession(this.ctx, arg, acknowledgedAtOrFence as string, fence);
    }
    return sessions.acknowledgeSession(this.ctx, arg);
  }

  finishSession(opts: {
    sessionId: string;
    worktreeId?: string | null;
    attemptId: string;
    status: string;
    queueShard: number;
    completedAt?: string;
    errorCode?: string;
    errorMessage?: string;
    exitCode?: number | null;
    cliResumeRef?: string;
    fence?: { hostId: string; connectionId: string };
    concurrencyId?: string;
  }): Promise<boolean> {
    return sessions.finishSession(this.ctx, opts);
  }

  releaseWorktree(worktreeId: string, opts?: { forceOffline?: boolean }): Promise<void> {
    return sessions.releaseWorktree(this.ctx, worktreeId, opts);
  }

  setWorktreeOnline(worktreeId: string, online: boolean): Promise<void> {
    return sessions.setWorktreeOnline(this.ctx, worktreeId, online);
  }

  setWorktreeOnlineFenced(
    worktreeId: string,
    connectionId: string,
    online: boolean,
    fence?: { hostId: string; connectionId: string },
  ): Promise<boolean> {
    return sessions.setWorktreeOnlineFenced(this.ctx, worktreeId, connectionId, online, fence);
  }

  tryAcquireHostLock(opts: {
    hostId: string;
    connectionId: string;
    replaceExisting: boolean;
  }): Promise<boolean> {
    return locks.tryAcquireHostLock(this.ctx, opts);
  }

  tryRegisterHost(opts: {
    hostId: string;
    connection: ConnectionRecord;
    replaceExisting: boolean;
    existingConnectionId?: string;
  }): Promise<boolean> {
    return locks.tryRegisterHost(this.ctx, opts);
  }

  releaseHostLock(hostId: string, connectionId: string): Promise<void> {
    return locks.releaseHostLock(this.ctx, hostId, connectionId);
  }

  releaseHostConnection(hostId: string, connectionId: string): Promise<boolean> {
    return locks.releaseHostConnection(this.ctx, { hostId, connectionId });
  }

  heartbeatConnection(hostId: string, connectionId: string, at: string): Promise<boolean> {
    return locks.heartbeatConnection(this.ctx, { hostId, connectionId, at });
  }

  markHostDraining(hostId: string, connectionId: string): Promise<boolean> {
    return locks.markHostDraining(this.ctx, { hostId, connectionId });
  }

  getHostLock(hostId: string): Promise<string | null> {
    return locks.getHostLock(this.ctx, hostId);
  }

  putConnection(conn: ConnectionRecord): Promise<void> {
    return locks.putConnection(this.ctx, conn);
  }

  getConnection(connectionId: string): Promise<ConnectionRecord | null> {
    return locks.getConnection(this.ctx, connectionId);
  }

  deleteConnection(connectionId: string): Promise<void> {
    return locks.deleteConnection(this.ctx, connectionId);
  }

  listConnections(): Promise<ConnectionRecord[]> {
    return locks.listConnections(this.ctx);
  }

  putLog(rec: LogRecord): Promise<void> {
    return catalog.putLog(this.ctx, rec);
  }

  putLogFenced(rec: LogRecord, fence: { hostId: string; connectionId: string }): Promise<boolean> {
    return catalog.putLogFenced(this.ctx, rec, fence);
  }

  deleteLog(sessionId: string, timestampSeq: string): Promise<void> {
    return catalog.deleteLog(this.ctx, sessionId, timestampSeq);
  }

  listLogs(sessionId: string): Promise<LogRecord[]> {
    return catalog.listLogs(this.ctx, sessionId);
  }

  putSchedule(rec: ScheduleRecord): Promise<void> {
    return catalog.putSchedule(this.ctx, rec);
  }

  getSchedule(id: string): Promise<ScheduleRecord | null> {
    return catalog.getSchedule(this.ctx, id);
  }

  listSchedules(): Promise<ScheduleRecord[]> {
    return catalog.listSchedules(this.ctx);
  }

  deleteSchedule(id: string): Promise<void> {
    return catalog.deleteSchedule(this.ctx, id);
  }

  putRepository(rec: RepositoryRecord): Promise<void> {
    return catalog.putRepository(this.ctx, rec);
  }

  getRepository(id: string): Promise<RepositoryRecord | null> {
    return catalog.getRepository(this.ctx, id);
  }

  listRepositories(): Promise<RepositoryRecord[]> {
    return catalog.listRepositories(this.ctx);
  }

  deleteRepository(id: string): Promise<void> {
    return catalog.deleteRepository(this.ctx, id);
  }

  tryClaimSchedule(
    scheduleId: string,
    expectedNextRunAt: string,
    newNextRunAt: string,
    lastRunAt: string,
  ): Promise<boolean> {
    return catalog.tryClaimSchedule(
      this.ctx,
      scheduleId,
      expectedNextRunAt,
      newNextRunAt,
      lastRunAt,
    );
  }

  tryClaimScheduleAndCreateSession(opts: {
    scheduleId: string;
    expectedNextRunAt: string;
    newNextRunAt: string;
    lastRunAt: string;
    session: import("./types.ts").SessionRecord;
  }): Promise<catalog.ScheduleCreateResult> {
    return catalog.tryClaimScheduleAndCreateSession(this.ctx, opts);
  }

  skipScheduleForActiveConcurrency(opts: {
    scheduleId: string;
    expectedNextRunAt: string;
    newNextRunAt: string;
    concurrencyId: string;
    sessionId: string;
  }): Promise<boolean> {
    return catalog.skipScheduleForActiveConcurrency(this.ctx, opts);
  }

  putArchive(obj: ArchiveObject): Promise<void> {
    return catalog.putArchive(this.ctx, obj);
  }

  getArchive(key: string): Promise<ArchiveObject | null> {
    return catalog.getArchive(this.ctx, key);
  }

  listArchives(): Promise<ArchiveObject[]> {
    return catalog.listArchives(this.ctx);
  }

  putHostInventory(rec: HostInventoryRecord): Promise<void> {
    return catalog.putHostInventory(this.ctx, rec);
  }

  getHostInventory(hostId: string): Promise<HostInventoryRecord | null> {
    return catalog.getHostInventory(this.ctx, hostId);
  }

  listHostInventories(): Promise<HostInventoryRecord[]> {
    return catalog.listHostInventories(this.ctx);
  }

  deleteHostInventory(hostId: string): Promise<void> {
    return catalog.deleteHostInventory(this.ctx, hostId);
  }

  putAuthAccount(rec: AuthAccountRecord): Promise<void> {
    return auth.putAuthAccount(this.ctx, rec);
  }

  getAuthAccount(id: string): Promise<AuthAccountRecord | null> {
    return auth.getAuthAccount(this.ctx, id);
  }

  getAuthAccountByUsername(username: string): Promise<AuthAccountRecord | null> {
    return auth.getAuthAccountByUsername(this.ctx, username);
  }

  listAuthAccounts(): Promise<AuthAccountRecord[]> {
    return auth.listAuthAccounts(this.ctx);
  }

  deleteAuthAccount(id: string): Promise<void> {
    return auth.deleteAuthAccount(this.ctx, id);
  }
}
