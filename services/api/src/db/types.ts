import type { SessionResumeSpec, SessionStatus, TargetRef } from "@auto-harness/shared";
export type { UsageRecord } from "../usage.ts";

export type SessionRecord = {
  id: string;
  repositoryId: string;
  prompt: string;
  target: TargetRef;
  fallbacks: TargetRef[];
  /** Human-readable primary + fallback display names, fixed at creation. */
  targetDisplayNames: string[];
  queueTtlSeconds: number;
  queueExpiresAt: string;
  /** The route used for the current or most recent assignment. */
  resolvedRoute?: {
    targetIndex: number;
    providerId?: string;
    providerAccountId?: string;
    commandId: string;
    hostId: string;
    worktreeId: string | null;
    /** Immutable token for the assignment that resolved this route. */
    attemptId: string;
  };
  /** Immutable token for the current or most recent assignment. */
  attemptId?: string | undefined;
  /** Providerless target indexes that reported a usage limit for this session. */
  suppressedTargetIndexes?: number[];
  /** Consecutive usage_limit retries so far (Invariant 6's exponential backoff). */
  retryCount?: number;
  /** Backoff deadline before a usage_limit retry may be scheduled again. */
  retryAfter?: string;
  /** Final argv, resolved once assigned to a worktree (cascade walk + prompt append). */
  resolvedArgv?: string[];
  /** Frozen native-resume configuration from the first assignment. */
  resumeSpec?: SessionResumeSpec | undefined;
  timeout: number;
  priority: number;
  requiredLabels: string[];
  status: SessionStatus;
  queueShard: number;
  createdAt: string;
  ref?: string;
  worktreeId?: string | null;
  hostId?: string | null;
  concurrencyId?: string | undefined;
  /** Schedule provenance; distinct from the possibly shared concurrency identity. */
  scheduleId?: string;
  metadata?: Record<string, unknown>;
  /** Authenticated principal that admitted this work; never accepted as a public selector. */
  principalId?: string;
  /** Durable proof that this drain operation performed the cancellation. */
  cancelledByDrainOperationId?: string;
  errorCode?: string | undefined;
  errorMessage?: string | undefined;
  url?: string;
  type?: string | undefined;
  source?: string | undefined;
  startedAt?: string | undefined;
  completedAt?: string | undefined;
  ackReceivedAt?: string;
  /** Exact host lease that claimed this running assignment. */
  assignmentConnectionId?: string | undefined;
  /** Durable assignment timestamp used to reclaim an unacknowledged scheduled run after restart. */
  assignmentSentAt?: string;
  /** Deadline after an acknowledged daemon disconnects before this work is requeued. */
  reconnectDeadlineAt?: string;
  exitCode?: number | null | undefined;
  cliResumeRef?: string | undefined;
  resumedFromSessionId?: string;
  pinnedHostId?: string | null;
  pinnedProviderAccountId?: string | null;
  /** Exact route components required for a native CLI resume. */
  pinnedTargetIndex?: number;
  pinnedCommandId?: string;
  pinExpiresAt?: string | undefined;
  resumeFallback?: boolean;
  /** The repository main checkout is held by this scheduled session. */
  mainCheckoutLease?: boolean;
  /** Attempt-owned provider-account concurrency lease, if this route is gated. */
  providerAccountLease?: {
    concurrencyId: string;
    providerAccountId: string;
    slot: number;
    attemptId: string;
  };
  /** Host that owned a provider lease when a timeout cleared the assignment. */
  timedOutHostId?: string;
  /** Original host connection used to fence legacy timeout capacity repair. */
  timedOutAssignmentConnectionId?: string;
  /** Transactional host-wide assignment-cap reservation, when advertised. */
  hostAssignmentLease?: {
    hostId: string;
  };
  /** Idempotency marker for post-transition repair of a pre-lease host slot. */
  legacyHostAssignmentReleased?: boolean;
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
