import type { SessionStatus } from "@auto-harness/shared";

import type { PlaneStorageCtx } from "./plane-storage-types.ts";
import {
  claimSessionRetention,
  leaseSessionRetentionJob,
} from "./plane-storage-session-retention-claim.ts";
import { finishSessionRetentionJob } from "./plane-storage-session-retention-finish.ts";
import {
  SESSION_DELETION_FENCE_SCOPE,
  sessionRetentionAdmissionCheck,
  sessionRetentionEligible,
} from "./plane-storage-session-retention-eligibility.ts";
import {
  getRetentionSession,
  listRetentionCandidates,
  listRetentionJobs,
  loadRetentionCursor,
  nextRetentionPartition,
  saveRetentionCursor,
} from "./plane-storage-session-retention-queries.ts";
import { deleteSessionRetentionRelatedPage } from "./plane-storage-session-retention-related.ts";
import type { RetentionJob } from "./plane-storage-session-retention-types.ts";
import type { SessionRecord } from "./types.ts";

export { SESSION_DELETION_FENCE_SCOPE, sessionRetentionAdmissionCheck, sessionRetentionEligible };
export type { RetentionJob };

/** Base-table work rows outlive a policy change and fence deletion across process death. */
export class DynamoSessionRetentionStore {
  private readonly ctx: PlaneStorageCtx;

  constructor(ctx: PlaneStorageCtx) {
    this.ctx = ctx;
  }

  getSession(id: string): Promise<SessionRecord | null> {
    return getRetentionSession(this.ctx, id);
  }

  nextPartition(count: number): Promise<number> {
    return nextRetentionPartition(this.ctx, count);
  }

  loadCursor(name: string): Promise<Record<string, unknown> | undefined> {
    return loadRetentionCursor(this.ctx, name);
  }

  saveCursor(name: string, nextKey?: Record<string, unknown>): Promise<void> {
    return saveRetentionCursor(this.ctx, name, nextKey);
  }

  listCandidates(
    status: SessionStatus,
    shard: number,
    cutoff: string,
    limit: number,
    startKey?: Record<string, unknown>,
  ) {
    return listRetentionCandidates(this.ctx, status, shard, cutoff, limit, startKey);
  }

  claim(session: SessionRecord, now: string, retentionDays = 30): Promise<boolean> {
    return claimSessionRetention(this.ctx, session, now, retentionDays);
  }

  listJobs(now: string, limit: number, startKey?: Record<string, unknown>) {
    return listRetentionJobs(this.ctx, now, limit, startKey);
  }

  lease(job: RetentionJob, now: string, owner: string): Promise<boolean> {
    return leaseSessionRetentionJob(this.ctx, job, now, owner);
  }

  deleteRelatedPage(sessionId: string, kind: "usage" | "logs"): Promise<boolean> {
    return deleteSessionRetentionRelatedPage(this.ctx, sessionId, kind);
  }

  finish(job: RetentionJob, owner: string, now: string): Promise<boolean> {
    return finishSessionRetentionJob(this.ctx, job, owner, now);
  }
}
