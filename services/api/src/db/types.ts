import type { SessionStatus } from "@auto-harness/shared";

export type SessionRecord = {
  id: string;
  repositoryId: string;
  prompt: string;
  /** Exactly one of providerAccountId/commandId is set. */
  providerAccountId?: string;
  commandId?: string;
  /** Human-readable label for display, e.g. "claude — jonathanrichardong@gmail.com" or "echo hello world". */
  targetLabel: string;
  /** Final argv, resolved once assigned to a worktree (cascade walk + prompt append). */
  resolvedArgv?: string[];
  timeout: number;
  priority: number;
  requiredLabels: string[];
  onConflict: "queue" | "replace" | "reject";
  status: SessionStatus;
  queueShard: number;
  createdAt: string;
  ref?: string;
  worktreeId?: string | null;
  hostId?: string | null;
  concurrencyKey?: string;
  metadata?: Record<string, unknown>;
  errorCode?: string;
  errorMessage?: string;
  url?: string;
  type?: string;
  source?: string;
  retryCount?: number;
  retryAfter?: string;
  startedAt?: string;
  completedAt?: string;
  ackReceivedAt?: string;
  exitCode?: number | null;
  cliResumeRef?: string;
  resumedFromSessionId?: string;
  pinnedHostId?: string | null;
  pinExpiresAt?: string;
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
