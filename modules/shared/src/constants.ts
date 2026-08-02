import type { OnConflict, SessionErrorCode, SessionStatus } from "./types.js";

export const SESSION_STATUSES = [
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "timed_out",
] as const satisfies readonly SessionStatus[];

export const TERMINAL_SESSION_STATUSES = [
  "completed",
  "failed",
  "cancelled",
  "timed_out",
] as const satisfies readonly SessionStatus[];

export const SESSION_ERROR_CODES = [
  "usage_limit",
  "resume_failed",
  "unknown_command_profile",
  "setup_failed",
] as const satisfies readonly SessionErrorCode[];

export const ON_CONFLICT_OPTIONS = [
  "queue",
  "replace",
  "reject",
] as const satisfies readonly OnConflict[];

/** Default max usage_limit auto-retries (docs/plan.md Invariant 6). */
export const DEFAULT_USAGE_LIMIT_RETRY_CEILING = 2;

/** Default queue shard count for status-createdAt GSI. */
export const DEFAULT_QUEUE_SHARD_COUNT = 4;

/** Session:assign must be acked within this window (Invariant 2). */
export const DEFAULT_ACK_DEADLINE_MS = 15_000;

/**
 * Worktree reclaim if agent heartbeat is older than this (Phase 3).
 * Must be materially smaller than typical session timeouts.
 */
export const DEFAULT_HEARTBEAT_STALE_MS = 60_000;

/** Agent-initiated keepalive interval (not server-originated). */
export const DEFAULT_AGENT_KEEPALIVE_MS = 20_000;

/** Session log archival target prefix (Phase 5). */
export const DEFAULT_ARCHIVE_PREFIX = "session-logs/";

export const PACKAGE_SCOPE = "@auto-harness" as const;
