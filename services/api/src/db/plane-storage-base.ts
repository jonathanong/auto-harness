/* eslint-disable max-lines */
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { SessionStatus } from "@auto-harness/shared";
import type { SessionResumeSpec } from "@auto-harness/shared";

import type { DynamoTableNames } from "./dynamo.ts";
import type { SessionRecord, UsageRecord, WorktreeRecord } from "./types.ts";
import {
  type HostInventoryRecord,
  type ArchiveMetadata,
  type ConnectionRecord,
  type AuthAccountRecord,
  type LogQuery,
  type LogRecord,
  type PlaneStorageCtx,
  type RepositoryRecord,
  type SessionDrainRecord,
  type ScheduleRecord,
} from "./plane-storage-types.ts";
import * as sessions from "./plane-storage-sessions.ts";
import * as reconnect from "./plane-storage-reconnect.ts";
import * as reconnectRollback from "./plane-storage-reconnect-rollback.ts";
import * as locks from "./plane-storage-locks.ts";
import * as catalog from "./plane-storage-catalog.ts";
import * as auth from "./plane-storage-auth.ts";
import * as mainCheckout from "./plane-storage-main-checkout.ts";
import * as deletionMarkers from "./plane-storage-deletion-markers.ts";
import * as usage from "./plane-storage-usage.ts";
import * as sessionDrains from "./plane-storage-session-drains.ts";
import * as repositoryCounts from "./plane-storage-repository-counts.ts";
import { migrateSessionDrainActivityLedgerPage } from "./ensure-session-drain-ledger.ts";
import { backfillQueuedSessionQueueOrder } from "./ensure-queue-order-index.ts";

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

  /** Bounded deployment migration; scheduler callers run at most one page. */
  migrateSessionDrainActivityLedgerPage(): Promise<boolean> {
    return migrateSessionDrainActivityLedgerPage(this.ctx.doc, this.ctx.tables);
  }

  /** Repair queued rows missing `queueOrder`. Safe to repeat; later requeues are also written. */
  async backfillQueuedSessionQueueOrder(shardCount?: number): Promise<void> {
    await backfillQueuedSessionQueueOrder(this.ctx.doc, this.ctx.tables.sessions, shardCount);
  }

  putSession(session: SessionRecord): Promise<void> {
    return sessions.putSession(this.ctx, session);
  }

  createSession(
    session: SessionRecord,
    markers?: readonly import("./plane-storage-deletion-markers.ts").DeletionMarker[],
  ): Promise<sessions.CreateSessionResult> {
    return sessions.createSession(this.ctx, session, markers);
  }

  releaseConcurrencyLock(concurrencyId: string, sessionId: string): Promise<void> {
    return sessions.releaseConcurrencyLock(this.ctx, concurrencyId, sessionId);
  }

  cancelRunningSession(
    opts: Parameters<typeof sessions.cancelRunningSession>[1],
  ): Promise<boolean> {
    return sessions.cancelRunningSession(this.ctx, opts);
  }

  getSession(id: string, consistentRead = false): Promise<SessionRecord | null> {
    return sessions.getSession(this.ctx, id, consistentRead);
  }

  listAllSessions(consistentRead = false): Promise<SessionRecord[]> {
    return sessions.listAllSessions(this.ctx, consistentRead);
  }

  listSessionsByRepository(repositoryId: string): Promise<SessionRecord[]> {
    return sessions.listSessionsByRepository(this.ctx, repositoryId);
  }

  async listSessionsForDrain(
    repositoryId: string,
    principalId: string,
    _operationId: string,
    _shardCount: number,
    cursor?: Record<string, unknown>,
  ): Promise<{ sessions: SessionRecord[]; nextKey?: Record<string, unknown> }> {
    const page = await sessionDrains.listSessionDrainActivityPage(
      this.ctx,
      repositoryId,
      principalId,
      cursor,
    );
    const records: SessionRecord[] = [];
    // A principal may have a long activity history after an outage. Bound the
    // exact strong reads instead of creating an unbounded Promise.all burst.
    const exactReadConcurrency = 20;
    for (let offset = 0; offset < page.records.length; offset += exactReadConcurrency) {
      const resolved = await Promise.all(
        page.records.slice(offset, offset + exactReadConcurrency).map(async (activity) => ({
          activity,
          session: await sessions.getSession(this.ctx, activity.sessionId, true),
        })),
      );
      for (const { activity, session } of resolved) {
        const owner = session?.principalId ?? session?.metadata?.createdBy;
        const stillOccupiesScope =
          session?.status === "queued" ||
          session?.status === "running" ||
          (session?.status === "cancelled" &&
            (session.worktreeId != null || session.mainCheckoutLease === true));
        if (
          session &&
          session.repositoryId === repositoryId &&
          owner === principalId &&
          stillOccupiesScope
        ) {
          records.push(session);
          continue;
        }
        // Session IDs and principal ownership are immutable after admission.
        // A missing or terminal exact row can therefore only make this member
        // stale. Deleting with both immutable attributes avoids racing a
        // hand-repaired/recreated activity row.
        await sessionDrains.deleteSessionDrainActivity(this.ctx, activity);
        if (session?.repositoryId === repositoryId && owner === principalId) records.push(session);
      }
    }
    return { sessions: records, ...(page.nextKey ? { nextKey: page.nextKey } : {}) };
  }

  countSessionsByRepository(repositoryId: string, hostId?: string): Promise<number> {
    return sessions.countSessionsByRepository(this.ctx, repositoryId, hostId);
  }

  countWorktreesByRepository(repositoryId: string, hostId?: string): Promise<number> {
    return repositoryCounts.countWorktreesByRepository(this.ctx, repositoryId, hostId);
  }

  countSchedulesByRepository(repositoryId: string): Promise<number> {
    return repositoryCounts.countSchedulesByRepository(this.ctx, repositoryId);
  }

  async listSessionsByHost(hostId: string): Promise<SessionRecord[]> {
    return (await sessions.listAllSessions(this.ctx)).filter(
      (session) => session.hostId === hostId,
    );
  }

  listSessionsByStatus(status: SessionStatus, shard: number): Promise<SessionRecord[]> {
    return sessions.listSessionsByStatus(this.ctx, status, shard);
  }

  createOrGetSessionDrain(
    record: SessionDrainRecord,
    audit: import("../audit-types.ts").AuditLogRecord,
  ): Promise<{ created: boolean; drain: SessionDrainRecord }> {
    return sessionDrains.createOrGetSessionDrain(this.ctx, record, audit);
  }

  getSessionDrain(repositoryId: string, principalId: string): Promise<SessionDrainRecord | null> {
    return sessionDrains.getSessionDrain(this.ctx, repositoryId, principalId);
  }

  getSessionDrainOperation(
    repositoryId: string,
    principalId: string,
    operationId: string,
  ): Promise<SessionDrainRecord | null> {
    return sessionDrains.getSessionDrainOperation(this.ctx, repositoryId, principalId, operationId);
  }

  listSessionDrains(consistentRead = false): Promise<SessionDrainRecord[]> {
    return sessionDrains.listSessionDrains(this.ctx, consistentRead);
  }

  listSessionDrainReconcileCandidates(limit?: number): Promise<SessionDrainRecord[]> {
    return sessionDrains.listSessionDrainReconcileCandidates(this.ctx, limit);
  }

  updateSessionDrain(
    record: SessionDrainRecord,
    audit?: import("../audit-types.ts").AuditLogRecord,
  ): Promise<boolean> {
    return sessionDrains.updateSessionDrain(this.ctx, record, audit);
  }

  claimSessionDrainReconcile(
    record: SessionDrainRecord,
    owner: string,
    now: string,
  ): Promise<SessionDrainRecord | null> {
    return sessionDrains.claimSessionDrainReconcile(this.ctx, record, owner, now);
  }

  releaseSessionDrain(
    released: SessionDrainRecord,
    audit: import("../audit-types.ts").AuditLogRecord,
  ): Promise<SessionDrainRecord | null> {
    return sessionDrains.releaseSessionDrain(this.ctx, released, audit);
  }

  putUsageRecord(
    record: UsageRecord,
    fence?: { hostId: string; connectionId: string },
  ): Promise<boolean> {
    return usage.putUsageRecord(this.ctx, record, fence);
  }

  listUsageRecords(sessionId?: string): Promise<UsageRecord[]> {
    return usage.listUsageRecords(this.ctx, sessionId);
  }

  putWorktree(wt: WorktreeRecord): Promise<void> {
    return sessions.putWorktree(this.ctx, wt);
  }

  deleteWorktree(id: string): Promise<void> {
    return sessions.deleteWorktree(this.ctx, id);
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

  listAllWorktrees(consistentRead = false): Promise<WorktreeRecord[]> {
    return sessions.listAllWorktrees(this.ctx, consistentRead);
  }

  async listWorktreesByHost(hostId: string): Promise<WorktreeRecord[]> {
    return (await sessions.listAllWorktrees(this.ctx)).filter(
      (worktree) => worktree.hostId === hostId,
    );
  }

  listWorktreesForRepo(repositoryId: string, consistentRead = false): Promise<WorktreeRecord[]> {
    return sessions.listWorktreesForRepo(this.ctx, repositoryId, consistentRead);
  }

  tryClaimWorktree(opts: { worktreeId: string; sessionId: string; now: string }): Promise<boolean> {
    return sessions.tryClaimWorktree(this.ctx, opts);
  }

  tryAssignSession(opts: {
    sessionId: string;
    repositoryId: string;
    worktreeId: string;
    hostId: string;
    hostInventoryVersion: number | null;
    principalId?: string;
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

  ensureMainCheckoutLeaseMap(hostId: string, connectionId: string): Promise<boolean> {
    return mainCheckout.ensureMainCheckoutLeaseMap(this.ctx, hostId, connectionId);
  }

  getMainCheckoutCursor(hostId: string): Promise<string | null> {
    return mainCheckout.getMainCheckoutCursor(this.ctx, hostId);
  }

  getMainCheckoutLease(
    hostId: string,
    repositoryId: string,
  ): Promise<{ sessionId: string; connectionId: string } | null> {
    return mainCheckout.getMainCheckoutLease(this.ctx, hostId, repositoryId);
  }

  tryAssignMainCheckoutSession(opts: {
    sessionId: string;
    hostId: string;
    hostInventoryVersion: number | null;
    principalId?: string;
    repositoryId: string;
    connectionId: string;
    now: string;
    resolvedArgv: string[];
    resumeSpec?: SessionResumeSpec;
    resolvedRoute: SessionRecord["resolvedRoute"];
    providerAccountId?: string;
    queueShard: number;
    attemptId: string;
  }): Promise<boolean> {
    return mainCheckout.tryAssignMainCheckoutSession(this.ctx, opts);
  }

  cancelRunningMainCheckoutSession(opts: {
    sessionId: string;
    hostId: string;
    connectionId: string;
    attemptId: string;
    queueShard: number;
    completedAt: string;
    deadlineAt: string;
    errorMessage: string;
    drainOperationId?: string;
  }): Promise<boolean> {
    return mainCheckout.cancelRunningMainCheckoutSession(this.ctx, opts);
  }

  releaseMainCheckoutSession(opts: {
    sessionId: string;
    hostId: string;
    repositoryId: string;
    connectionId: string;
    status: string;
    queueShard: number;
    reason?: string | undefined;
    completedAt?: string | undefined;
    exitCode?: number | null | undefined;
    errorCode?: string | undefined;
    cliResumeRef?: string | undefined;
    retryCount?: number;
    retryAfter?: string;
    suppressedTargetIndex?: number;
    expectedStatus?: "running" | "cancelled";
    attemptId?: string;
    concurrencyId?: string | undefined;
    requireUnacknowledged?: boolean;
  }): Promise<boolean> {
    return mainCheckout.releaseMainCheckoutSession(this.ctx, opts);
  }

  requeueMainCheckoutUsageLimitedSession(opts: {
    sessionId: string;
    hostId: string;
    repositoryId: string;
    connectionId: string;
    attemptId: string;
    providerAccountId: string;
    queueShard: number;
    now: string;
    usageLimitedUntil: string;
    errorMessage?: string | undefined;
  }): Promise<boolean> {
    return mainCheckout.requeueMainCheckoutUsageLimitedSession(this.ctx, opts);
  }

  markMainCheckoutReconnectPending(opts: {
    sessionId: string;
    hostId: string;
    repositoryId: string;
    connectionId: string;
    deadlineAt: string;
  }): Promise<boolean> {
    return mainCheckout.markMainCheckoutReconnectPending(this.ctx, opts);
  }

  confirmMainCheckoutReconnect(opts: {
    sessionId: string;
    hostId: string;
    repositoryId: string;
    oldConnectionId: string;
    connectionId: string;
    deadlineAt?: string;
  }): Promise<boolean> {
    return mainCheckout.confirmMainCheckoutReconnect(this.ctx, opts);
  }

  restoreMainCheckoutReconnect(opts: {
    sessionId: string;
    hostId: string;
    repositoryId: string;
    connectionId: string;
    previousConnectionId: string;
    previousDeadlineAt?: string;
  }): Promise<boolean> {
    return mainCheckout.restoreMainCheckoutReconnect(this.ctx, opts);
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
    pinExpiresAt?: string | undefined;
  }): Promise<boolean> {
    return sessions.clearResumePin(this.ctx, opts);
  }

  expireQueuedSession(opts: {
    sessionId: string;
    queueShard: number;
    queueExpiresAt: string;
    completedAt: string;
    concurrencyId?: string;
  }): Promise<boolean> {
    return sessions.expireQueuedSession(this.ctx, opts);
  }

  cancelQueuedSession(opts: {
    sessionId: string;
    queueShard: number;
    completedAt: string;
    errorMessage: string;
    concurrencyId?: string;
    drainOperationId?: string;
    drainRepositoryId?: string;
    drainPrincipalId?: string;
  }): Promise<boolean> {
    return sessions.cancelQueuedSession(this.ctx, opts);
  }

  releaseCancelledSessionWorktree(opts: {
    sessionId: string;
    worktreeId: string;
    /** Terminal reports from a live daemon preserve reachability; disconnect
     * cleanup deliberately sets this false. Make the distinction explicit at
     * every callsite instead of deriving it from the terminal session. */
    online: boolean;
    cliResumeRef?: string | undefined;
    fence?: { hostId: string; connectionId: string } | undefined;
    attemptId: string;
    concurrencyId?: string | undefined;
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
    worktreeId: string | null;
    attemptId: string;
    acknowledgedAt: string;
    fence?: { hostId: string; connectionId: string };
  }): Promise<boolean>;
  acknowledgeSession(
    arg:
      | string
      | {
          sessionId: string;
          worktreeId: string | null;
          attemptId: string;
          acknowledgedAt: string;
          fence?: { hostId: string; connectionId: string };
        },
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

  // `draining?: boolean | undefined` since callers commonly forward an already-optional
  // registration option verbatim.
  tryAcquireHostLock(opts: {
    hostId: string;
    connectionId: string;
    replaceExisting: boolean;
    draining?: boolean | undefined;
  }): Promise<boolean> {
    return locks.tryAcquireHostLock(this.ctx, opts);
  }

  tryRegisterHost(opts: {
    hostId: string;
    connection: ConnectionRecord;
    replaceExisting: boolean;
    existingConnectionId?: string;
    consumePendingConnection?: boolean;
    draining?: boolean | undefined;
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

  getHostLockState(hostId: string): Promise<locks.HostLockState> {
    return locks.getHostLockState(this.ctx, hostId);
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

  putLogsFenced(
    records: readonly LogRecord[],
    fence: { hostId: string; connectionId: string },
  ): Promise<boolean> {
    return catalog.putLogsFenced(this.ctx, records, fence);
  }

  deleteLog(sessionId: string, timestampSeq: string): Promise<void> {
    return catalog.deleteLog(this.ctx, sessionId, timestampSeq);
  }

  listLogs(sessionId: string): Promise<LogRecord[]> {
    return catalog.listLogs(this.ctx, sessionId);
  }

  queryLogs(sessionId: string, query: LogQuery): Promise<LogRecord[]> {
    return catalog.queryLogs(this.ctx, sessionId, query);
  }

  putSchedule(
    rec: ScheduleRecord,
    markers?: readonly import("./plane-storage-deletion-markers.ts").DeletionMarker[],
  ): Promise<void> {
    return catalog.putSchedule(this.ctx, rec, markers);
  }

  acquireDeletionMarker(key: string, owner: string, now: string): Promise<boolean> {
    return deletionMarkers.acquireDeletionMarker(this.ctx, key, owner, now);
  }

  releaseDeletionMarker(key: string, owner: string): Promise<void> {
    return deletionMarkers.releaseDeletionMarker(this.ctx, key, owner);
  }

  renewDeletionMarker(key: string, owner: string, now: string): Promise<boolean> {
    return deletionMarkers.renewDeletionMarker(this.ctx, key, owner, now);
  }

  updateScheduleManagement(
    rec: ScheduleRecord,
    expectedNextRunAt: string,
    markers?: readonly import("./plane-storage-deletion-markers.ts").DeletionMarker[],
  ): Promise<ScheduleRecord | null> {
    return catalog.updateScheduleManagement(this.ctx, rec, expectedNextRunAt, markers);
  }

  getSchedule(id: string): Promise<ScheduleRecord | null> {
    return catalog.getSchedule(this.ctx, id);
  }

  listSchedules(consistentRead = true): Promise<ScheduleRecord[]> {
    return catalog.listSchedules(this.ctx, consistentRead);
  }

  deleteSchedule(
    id: string,
    markers?: readonly import("./plane-storage-deletion-markers.ts").OwnedDeletionMarker[],
  ): Promise<void> {
    return catalog.deleteSchedule(this.ctx, id, markers);
  }

  putRepository(rec: RepositoryRecord): Promise<void> {
    return catalog.putRepository(this.ctx, rec);
  }

  updateRepositorySettings(
    id: string,
    patch: Partial<
      Pick<
        RepositoryRecord,
        "name" | "url" | "defaultBranch" | "setupScript" | "terminalHookScript"
      >
    >,
    updatedAt: string,
  ): Promise<RepositoryRecord | null> {
    return catalog.updateRepositorySettings(this.ctx, id, patch, updatedAt);
  }

  createRepository(rec: RepositoryRecord): Promise<boolean> {
    return catalog.createRepository(this.ctx, rec);
  }

  getRepository(id: string): Promise<RepositoryRecord | null> {
    return catalog.getRepository(this.ctx, id);
  }

  listRepositories(): Promise<RepositoryRecord[]> {
    return catalog.listRepositories(this.ctx);
  }

  listRepositoriesPage(
    query: import("./plane-storage-types.ts").RepositoryPageQuery,
  ): Promise<import("./plane-storage-types.ts").RepositoryPage> {
    return catalog.listRepositoriesPage(this.ctx, query);
  }

  setRepositoryAdmissionState(
    id: string,
    state: import("@auto-harness/shared").RepositoryAdmissionState,
    now: string,
    activationCutoffAt?: string,
  ): Promise<RepositoryRecord | null> {
    return catalog.setRepositoryAdmissionState(this.ctx, id, state, now, activationCutoffAt);
  }

  completeRepositoryDrain(
    id: string,
    drainRequestedAt: string,
    now: string,
  ): Promise<RepositoryRecord | null> {
    return catalog.completeRepositoryDrain(this.ctx, id, drainRequestedAt, now);
  }

  deleteRepository(
    id: string,
    markers?: readonly import("./plane-storage-deletion-markers.ts").OwnedDeletionMarker[],
  ): Promise<void> {
    return catalog.deleteRepository(this.ctx, id, markers);
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

  skipOwnerlessScheduleAndAudit(opts: {
    scheduleId: string;
    expectedNextRunAt: string;
    newNextRunAt: string;
    lastRunAt: string;
    audit: import("../audit-types.ts").AuditLogRecord;
  }): Promise<boolean> {
    return catalog.skipOwnerlessScheduleAndAudit(this.ctx, opts);
  }

  disableLegacyFallbackScheduleAndAudit(opts: {
    scheduleId: string;
    expectedNextRunAt: string;
    audit: import("../audit-types.ts").AuditLogRecord;
  }): Promise<boolean> {
    return catalog.disableLegacyFallbackScheduleAndAudit(this.ctx, opts);
  }

  tryClaimScheduleAndCreateSession(opts: {
    scheduleId: string;
    expectedNextRunAt: string;
    newNextRunAt: string;
    lastRunAt: string;
    activationCutoffAt?: string;
    expectedNextRunAtEpochMs?: number;
    session: import("./types.ts").SessionRecord;
  }): Promise<catalog.ScheduleCreateResult> {
    return catalog.tryClaimScheduleAndCreateSession(this.ctx, opts);
  }

  skipScheduleForClosedRepository(opts: {
    scheduleId: string;
    repositoryId: string;
    expectedNextRunAt: string;
    newNextRunAt: string;
  }): Promise<boolean> {
    return catalog.skipScheduleForClosedRepository(this.ctx, opts);
  }

  skipScheduleBeforeActivationCutoff(opts: {
    scheduleId: string;
    repositoryId: string;
    activationCutoffAt: string;
    expectedNextRunAt: string;
    newNextRunAt: string;
  }): Promise<boolean> {
    return catalog.skipScheduleBeforeActivationCutoff(this.ctx, opts);
  }

  skipScheduleForPrincipalDrain(opts: {
    scheduleId: string;
    repositoryId: string;
    principalId: string;
    operationId: string;
    expectedNextRunAt: string;
    newNextRunAt: string;
  }): Promise<boolean> {
    return catalog.skipScheduleForPrincipalDrain(this.ctx, opts);
  }

  skipScheduleForPrincipalDrainAndAudit(opts: {
    scheduleId: string;
    repositoryId: string;
    principalId: string;
    operationId: string;
    expectedNextRunAt: string;
    newNextRunAt: string;
    audit: import("../audit-types.ts").AuditLogRecord;
  }): Promise<boolean> {
    return catalog.skipScheduleForPrincipalDrainAndAudit(this.ctx, opts);
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

  putArchive(obj: ArchiveMetadata): Promise<void> {
    return catalog.putArchive(this.ctx, obj);
  }

  getArchive(key: string): Promise<ArchiveMetadata | null> {
    return catalog.getArchive(this.ctx, key);
  }

  listArchives(): Promise<ArchiveMetadata[]> {
    return catalog.listArchives(this.ctx);
  }

  /** Returns false when `expectedVersion` no longer matches the stored document. */
  putHostInventory(
    rec: HostInventoryRecord,
    markers?: readonly import("./plane-storage-deletion-markers.ts").DeletionMarker[],
    expectedVersion?: number,
  ): Promise<boolean> {
    return catalog.putHostInventory(this.ctx, rec, markers, expectedVersion);
  }

  /** See catalog.putHostInventoryFenced for why the result distinguishes lease vs. version. */
  putHostInventoryFenced(
    rec: HostInventoryRecord,
    fence: { hostId: string; connectionId: string },
    expectedVersion?: number,
  ): Promise<{ ok: true } | { ok: false; reason: "lease" | "version" }> {
    return catalog.putHostInventoryFenced(this.ctx, rec, fence, expectedVersion);
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

  updateAuthAccountPassword(
    id: string,
    expectedPasswordHash: string,
    passwordHash: string,
    updatedAt: string,
  ): Promise<boolean> {
    return auth.updateAuthAccountPassword(
      this.ctx,
      id,
      expectedPasswordHash,
      passwordHash,
      updatedAt,
    );
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

  deleteAuthAccountFenced(
    id: string,
    marker: import("./plane-storage-deletion-markers.ts").OwnedDeletionMarker,
  ): Promise<import("../auth-accounts.ts").FencedAuthAccountDelete> {
    return auth.deleteAuthAccountFenced(this.ctx, id, marker);
  }

  deleteAuthAccount(id: string): Promise<void> {
    return auth.deleteAuthAccount(this.ctx, id);
  }
}
