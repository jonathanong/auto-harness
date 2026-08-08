import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { SessionStatus } from "@auto-harness/shared";

import type { DynamoTableNames } from "./dynamo.ts";
import type { SessionRecord, WorktreeRecord } from "./types.ts";
import {
  type HostInventoryRecord,
  type ArchiveObject,
  type ConnectionRecord,
  type LogRecord,
  type PlaneStorageCtx,
  type RepositoryRecord,
  type ScheduleRecord,
} from "./plane-storage-types.ts";
import * as sessions from "./plane-storage-sessions.ts";
import * as locks from "./plane-storage-locks.ts";
import * as catalog from "./plane-storage-catalog.ts";

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

  getSession(id: string): Promise<SessionRecord | null> {
    return sessions.getSession(this.ctx, id);
  }

  listAllSessions(): Promise<SessionRecord[]> {
    return sessions.listAllSessions(this.ctx);
  }

  listSessionsByStatus(status: SessionStatus, shard: number): Promise<SessionRecord[]> {
    return sessions.listSessionsByStatus(this.ctx, status, shard);
  }

  putWorktree(wt: WorktreeRecord): Promise<void> {
    return sessions.putWorktree(this.ctx, wt);
  }

  getWorktree(id: string): Promise<WorktreeRecord | null> {
    return sessions.getWorktree(this.ctx, id);
  }

  listAllWorktrees(): Promise<WorktreeRecord[]> {
    return sessions.listAllWorktrees(this.ctx);
  }

  listWorktreesForRepo(repositoryId: string): Promise<WorktreeRecord[]> {
    return sessions.listWorktreesForRepo(this.ctx, repositoryId);
  }

  tryClaimWorktree(opts: { worktreeId: string; sessionId: string; now: string }): Promise<boolean> {
    return sessions.tryClaimWorktree(this.ctx, opts);
  }

  releaseWorktree(worktreeId: string, opts?: { forceOffline?: boolean }): Promise<void> {
    return sessions.releaseWorktree(this.ctx, worktreeId, opts);
  }

  setWorktreeOnline(worktreeId: string, online: boolean): Promise<void> {
    return sessions.setWorktreeOnline(this.ctx, worktreeId, online);
  }

  tryAcquireHostLock(opts: {
    hostId: string;
    connectionId: string;
    replaceExisting: boolean;
  }): Promise<boolean> {
    return locks.tryAcquireHostLock(this.ctx, opts);
  }

  releaseHostLock(hostId: string, connectionId: string): Promise<void> {
    return locks.releaseHostLock(this.ctx, hostId, connectionId);
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
}
