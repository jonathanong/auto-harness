import type { SessionResumeSpec, SessionStatus, TargetRef } from "@auto-harness/shared";
export type { UsageRecord } from "../usage.ts";

export type SessionRecord = {
  id: string;
  repositoryId: string;
  prompt: string;
  target: TargetRef;
  fallbacks: TargetRef[];
  /** Human-readable primary + fallback labels, fixed at creation. */
  targetLabels: string[];
  queueTtlSeconds: number;
  queueExpiresAt: string;
  /** The route used for the current or most recent assignment. */
  resolvedRoute?: {
    targetIndex: number;
    providerAccountId?: string;
    commandId: string;
    hostId: string;
    worktreeId: string | null;
    /** Immutable token for the assignment that resolved this route. */
    attemptId: string;
  };
  /** Immutable token for the current or most recent assignment. */
  attemptId?: string;
  /** Providerless target indexes that reported a usage limit for this session. */
  suppressedTargetIndexes?: number[];
  /** Final argv, resolved once assigned to a worktree (cascade walk + prompt append). */
  resolvedArgv?: string[];
  /** Frozen native-resume configuration from the first assignment. */
  resumeSpec?: SessionResumeSpec;
  timeout: number;
  priority: number;
  requiredLabels: string[];
  status: SessionStatus;
  queueShard: number;
  createdAt: string;
  ref?: string;
  worktreeId?: string | null;
  hostId?: string | null;
  concurrencyId?: string;
  /** Schedule provenance; distinct from the possibly shared concurrency identity. */
  scheduleId?: string;
  metadata?: Record<string, unknown>;
  errorCode?: string;
  errorMessage?: string;
  url?: string;
  type?: string;
  source?: string;
  startedAt?: string;
  completedAt?: string;
  ackReceivedAt?: string;
  /** Exact host lease that claimed this running assignment. */
  assignmentConnectionId?: string;
  /** Durable assignment timestamp used to reclaim an unacknowledged scheduled run after restart. */
  assignmentSentAt?: string;
  /** Deadline after an acknowledged daemon disconnects before this work is requeued. */
  reconnectDeadlineAt?: string;
  exitCode?: number | null;
  cliResumeRef?: string;
  resumedFromSessionId?: string;
  pinnedHostId?: string | null;
  pinnedProviderAccountId?: string | null;
  /** Exact route components required for a native CLI resume. */
  pinnedTargetIndex?: number;
  pinnedCommandId?: string;
  pinExpiresAt?: string;
  resumeFallback?: boolean;
  /** The repository main checkout is held by this scheduled session. */
  mainCheckoutLease?: boolean;
};

export type WorktreeRecord = {
  id: string;
  name: string;
  hostId: string;
  repositoryId: string;
  path: string;
  labels: string[];
  status: "idle" | "busy" | "error";
  online: boolean;
  currentSessionId?: string | null;
  /** Exact host lease that last published this worktree inventory/claim. */
  connectionId?: string;
  lastAssignedAt?: string | null;
};
