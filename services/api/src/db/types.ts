import type {
  SessionResult,
  SessionResumeSpec,
  SessionStatus,
  TargetRef,
} from "@auto-harness/shared";
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
  /** Sparse active host-claim index; absent once every host lease is released. */
  activeHostId?: string;
  /** Unique ordering key for the sparse active host-claim index. */
  activeHostOrder?: string;
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
  /** Number of automatic retries consumed by transient infrastructure loss. */
  infrastructureRetryCount?: number;
  /** Most recent retryable infrastructure failure, retained across attempts. */
  lastInfrastructureErrorCode?: "checkout_fetch_failed" | "host_lost";
  /** Attempt whose failure consumed the automatic infrastructure retry. */
  infrastructureRetryAttemptId?: string;
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
  /** Durable v4 command-launch checkpoint. Never expose this to browser clients. */
  primaryCommandStartState?: "pending" | "authorized";
  /** Deadline after an acknowledged daemon disconnects before this work is requeued. */
  reconnectDeadlineAt?: string;
  exitCode?: number | null | undefined;
  cliResumeRef?: string | undefined;
  /** Bounded machine-readable terminal outcome, absent for legacy/unavailable reports. */
  result?: SessionResult;
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
  /**
   * A host-loss terminal outcome whose repository hook must be run by the
   * replacement daemon on the same host. It is retained on the active-host
   * index until that daemon durably confirms completion.
   */
  terminalHookHandoff?: {
    handoffId: string;
    hostId: string;
    repositoryId: string;
    worktreeId: string | null;
    status: Extract<
      import("@auto-harness/shared").SessionStatus,
      "completed" | "failed" | "cancelled" | "timed_out"
    >;
    errorCode?: import("@auto-harness/shared").SessionErrorCode;
    /** Bounded recovery retention; expiry records a fail-closed no-op. */
    expiresAt: string;
    ref?: string;
    metadata?: Record<string, unknown>;
  };
  /** Exact handoff/host pair that settled the hook, retained for lost completion acknowledgements. */
  terminalHookHandoffSettled?: {
    handoffId: string;
    hostId: string;
  };
  /** Audit marker when the replacement daemon never returned before bounded recovery expired. */
  terminalHookHandoffExpiredAt?: string;
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
