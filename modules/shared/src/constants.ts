import type {
  SessionErrorCode,
  SessionSource,
  SessionStatus,
  SessionType,
  UserRole,
  WorktreeStatus,
} from "./types.ts";

// Shared by services/cdk (sets it as a CloudFront custom origin header) and
// services/api (the REQUEST authorizer's identitySource) so CloudFront-only
// traffic can be distinguished from a direct call to the origin.
export const CLOUDFRONT_INGRESS_TOKEN_HEADER = "x-auto-harness-ingress-token";

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

export const ACTIVE_SESSION_STATUSES = [
  "queued",
  "running",
] as const satisfies readonly SessionStatus[];

export const SESSION_ERROR_CODES = [
  "usage_limit",
  "queue_expired",
  "resume_failed",
  "unknown_command_profile",
  "setup_failed",
  "checkout_fetch_failed",
  "host_lost",
  "workspace_cleanup_failed",
] as const satisfies readonly SessionErrorCode[];

export const SESSION_TYPES = [
  "prompt",
  "scheduled",
  "workspace",
] as const satisfies readonly SessionType[];
export const SESSION_SOURCES = [
  "api",
  "ui",
  "webhook",
  "schedule",
] as const satisfies readonly SessionSource[];

export const USER_ROLES = [
  "read-only",
  "author",
  "operator",
  "maintainer",
  "agent",
  "admin",
] as const satisfies readonly UserRole[];

export const WORKTREE_STATUSES = [
  "idle",
  "busy",
  "error",
] as const satisfies readonly WorktreeStatus[];
/** Default max usage_limit auto-retries (docs/plan.md Invariant 6). */

/** A queued session has this long to find capacity before failing. */
export const DEFAULT_QUEUE_TTL_SECONDS = 691_200;

/** A provider account is paused for this long after reporting a usage limit. */
export const DEFAULT_USAGE_LIMIT_COOLDOWN_SECONDS = 18_000;

/** Default per-account concurrent session cap; operators may raise it. */
export const DEFAULT_MAX_CONCURRENT_SESSIONS = 1;

/** Hard ceiling for `ProviderAccount.maxConcurrentSessions`. */
export const MAX_CONCURRENT_SESSIONS_LIMIT = 64;

/** Default host-wide concurrent assignment cap advertised by modern daemons. */
export const DEFAULT_MAX_CONCURRENT_ASSIGNMENTS = 64;

/** Hard ceiling for `capabilities.maxConcurrentAssignments`. */
export const MAX_CONCURRENT_ASSIGNMENTS_LIMIT = 256;

/** Default queue shard count for status-createdAt GSI. */
export const DEFAULT_QUEUE_SHARD_COUNT = 4;

/** Session:assign must be acked within this window (Invariant 2). */
export const DEFAULT_ACK_DEADLINE_MS = 15_000;

/** Host control-channel protocol. Peers must advertise this exact version. */
export const HOST_PROTOCOL_VERSION = 7;

/** Wire bound for `session:log.dropped` (docs/websocket.md). */
export const MAX_SESSION_LOG_DROPPED = 1_000_000;

/**
 * Worktree reclaim if host heartbeat is older than this (Phase 3).
 * Must be materially smaller than typical session timeouts.
 */
export const DEFAULT_HEARTBEAT_STALE_MS = 60_000;

/** Host-initiated keepalive interval (not server-originated). */
export const DEFAULT_HOST_KEEPALIVE_MS = 20_000;

/** Session log archival target prefix (Phase 5). */
export const DEFAULT_ARCHIVE_PREFIX = "sessions/";

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

/**
 * Bare (unprefixed) DynamoDB table names granted `dynamodb:Scan` on the rest/websocket/cron
 * Lambda role (see services/cdk/src/foundation-data-access.ts, which re-exports this array to
 * attach the grant). Shared with services/api so `services/api/src/db/dynamo.ts` can derive a
 * `ScannableTableField` type restricted to exactly these tables — a caller passing an ungranted
 * table to a parameterized Scan helper is then a compile error, not just a scripts/
 * check-dynamo-scans.mts finding. Production Scan paths: catalog hydrate/list, auth hydrate,
 * session/worktree/connection snapshots, workspace pool/slot hydrate (listHostsDurable's
 * scheduler read model), custom webhook integration lookups (delete-guard reference scans), and
 * webhook outbox listing. SessionLogs, AuditLogs, and lock/TTL tables are Query/Get/Put only —
 * do not add them here.
 */
export const SCAN_TABLE_NAMES = [
  "Users",
  "Repositories",
  "Worktrees",
  "WorkspacePools",
  "WorkspaceSlots",
  "Sessions",
  "SessionDrains",
  "Schedules",
  "Connections",
  "Archives",
  "HostInventories",
  "Providers",
  "ProviderAccounts",
  "Commands",
  "SessionUsage",
  "Integrations",
  "WebhookDeliveries",
] as const;
