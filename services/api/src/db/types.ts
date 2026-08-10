import type { SessionResumeSpec, SessionStatus, TargetRef } from "@auto-harness/shared";

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
    worktreeId: string;
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

export interface SessionRepository {
  putNew(session: SessionRecord): Promise<void>;
  get(id: string): Promise<SessionRecord | null>;
  listByStatus(status: SessionStatus, shard: number): Promise<SessionRecord[]>;
  updateStatus(id: string, status: SessionStatus): Promise<void>;
}

export interface WorktreeRepository {
  /**
   * Conditional claim: idle → busy only if status is currently idle (Invariant 1).
   * Returns true if this caller won the claim.
   */
  tryClaim(opts: { worktreeId: string; sessionId: string; now: string }): Promise<boolean>;
  release(worktreeId: string): Promise<void>;
  listIdleForRepo(repositoryId: string): Promise<WorktreeRecord[]>;
}
