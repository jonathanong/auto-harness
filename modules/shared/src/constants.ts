import type {
  OnConflict,
  SessionErrorCode,
  SessionSource,
  SessionStatus,
  SessionType,
} from "./types.ts";

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
  "queue_expired",
  "resume_failed",
  "unknown_command_profile",
  "setup_failed",
] as const satisfies readonly SessionErrorCode[];

export const ON_CONFLICT_OPTIONS = [
  "queue",
  "replace",
  "reject",
] as const satisfies readonly OnConflict[];

export const SESSION_TYPES = ["prompt", "scheduled"] as const satisfies readonly SessionType[];
export const SESSION_SOURCES = [
  "api",
  "ui",
  "webhook",
  "schedule",
] as const satisfies readonly SessionSource[];

/** Default max usage_limit auto-retries (docs/plan.md Invariant 6). */
export const DEFAULT_USAGE_LIMIT_RETRY_CEILING = 2;

/** A queued session has this long to find capacity before failing. */
export const DEFAULT_QUEUE_TTL_SECONDS = 691_200;

/** A provider account is paused for this long after reporting a usage limit. */
export const DEFAULT_USAGE_LIMIT_COOLDOWN_SECONDS = 18_000;

/** Default queue shard count for status-createdAt GSI. */
export const DEFAULT_QUEUE_SHARD_COUNT = 4;

/** Session:assign must be acked within this window (Invariant 2). */
export const DEFAULT_ACK_DEADLINE_MS = 15_000;

/**
 * Worktree reclaim if host heartbeat is older than this (Phase 3).
 * Must be materially smaller than typical session timeouts.
 */
export const DEFAULT_HEARTBEAT_STALE_MS = 60_000;

/** Host-initiated keepalive interval (not server-originated). */
export const DEFAULT_HOST_KEEPALIVE_MS = 20_000;

/** Session log archival target prefix (Phase 5). */
export const DEFAULT_ARCHIVE_PREFIX = "session-logs/";

export const PACKAGE_SCOPE = "@auto-harness" as const;

/**
 * Local stack defaults (adjacent 7xxx ports). Override via HARNESS_* env in production.
 * Control-plane UI and host-pane UI are adjacent (7421/7422) so they're easy to tell apart;
 * DynamoDB Local (not a browser UI) trails at 7423.
 */
export const LOCAL_API_HTTP = "http://127.0.0.1:7420" as const;
export const LOCAL_API_WS = "ws://127.0.0.1:7420/ws" as const;
export const LOCAL_WEB_HTTP = "http://127.0.0.1:7421" as const;
export const LOCAL_HOST_PANE_HTTP = "http://127.0.0.1:7422" as const;
export const LOCAL_DDB_HTTP = "http://127.0.0.1:7423" as const;
export const LOCAL_HOST_ID = "local-1" as const;
