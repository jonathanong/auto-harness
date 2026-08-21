/** Session lifecycle statuses (docs/plan.md data model). */
export type SessionStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out";

export type SessionType = "prompt" | "scheduled";

export type SessionSource = "api" | "ui" | "webhook" | "schedule";

export type LogStream = "stdout" | "stderr" | "system";

/** Machine-readable failure reasons. */
export type SessionErrorCode =
  | "usage_limit"
  | "queue_expired"
  | "resume_failed"
  | "unknown_command_profile"
  | "setup_failed";

export type UserRole = "read-only" | "author" | "operator" | "maintainer" | "agent" | "admin";

export type AccountType = "user" | "service-account";

export type WorktreeStatus = "idle" | "busy" | "error";
