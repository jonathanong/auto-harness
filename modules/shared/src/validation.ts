/* eslint-disable max-lines */
import {
  ACTIVE_SESSION_STATUSES,
  SESSION_ERROR_CODES,
  SESSION_SOURCES,
  SESSION_STATUSES,
  TERMINAL_SESSION_STATUSES,
  SESSION_TYPES,
  USER_ROLES,
  WORKTREE_STATUSES,
  DEFAULT_QUEUE_TTL_SECONDS,
} from "./constants.ts";
import type {
  SessionErrorCode,
  SessionSource,
  SessionStatus,
  SessionType,
  UserRole,
  WorktreeStatus,
} from "./types.ts";
import { isValidScheduledBranchRef, isValidSessionRef } from "./scheduled-branch-ref.ts";
import type { SessionActiveStatus, SessionTerminalStatus, TargetRef } from "./session.ts";

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Upper bound on a session prompt. Without one, a prompt could grow to whatever the
 * request-body cap allows (1 MiB), well past DynamoDB's 400 KiB item limit once combined
 * with the rest of the session record.
 */
export const MAX_PROMPT_BYTES = 64 * 1024;

/** DynamoDB partition keys are limited to 2,048 UTF-8 bytes. */
export const MAX_CONCURRENCY_ID_BYTES = 2_048;

/** Shared UTF-8 byte-length check for create and resume prompts. */
export function promptByteLengthError(prompt: string): string | null {
  if (new TextEncoder().encode(prompt).length > MAX_PROMPT_BYTES) {
    return `prompt must be at most ${MAX_PROMPT_BYTES} bytes`;
  }
  return null;
}

/** Shared UTF-8 byte-length check for concurrency-lock partition keys. */
export function concurrencyIdByteLengthError(concurrencyId: string): string | null {
  if (new TextEncoder().encode(concurrencyId).length > MAX_CONCURRENCY_ID_BYTES) {
    return `concurrencyId must be at most ${MAX_CONCURRENCY_ID_BYTES} bytes`;
  }
  return null;
}
/** Seven days. Longer would keep a host process in setTimeout indefinitely. */
const MAX_SESSION_TIMEOUT_SECONDS = 7 * 24 * 60 * 60;
/** Thirty days. The default queue TTL is eight days. */
const MAX_QUEUE_TTL_SECONDS = 30 * 24 * 60 * 60;
const MAX_SESSION_PRIORITY = 10_000;
const MAX_REQUIRED_LABELS = 16;
const MAX_REQUIRED_LABEL_LENGTH = 64;
const MAX_METADATA_KEYS = 32;
const MAX_METADATA_KEY_LENGTH = 64;
const MAX_METADATA_STRING_LENGTH = 1_024;
// Scheduled claims combine reference-marker checks for every route with the
// cursor, repository, drain, session, activity, and concurrency-lock actions.
// 90 fallbacks keeps the authenticated worst case within DynamoDB's 100-action
// limit even when the principal marker is present.
export const MAX_FALLBACKS = 90;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function isSessionStatus(value: unknown): value is SessionStatus {
  return typeof value === "string" && (SESSION_STATUSES as readonly string[]).includes(value);
}

export function isTerminalSessionStatus(value: unknown): value is SessionTerminalStatus {
  return (
    typeof value === "string" && (TERMINAL_SESSION_STATUSES as readonly string[]).includes(value)
  );
}

export function isActiveSessionStatus(value: unknown): value is SessionActiveStatus {
  return (
    typeof value === "string" && (ACTIVE_SESSION_STATUSES as readonly string[]).includes(value)
  );
}

export function isSessionErrorCode(value: unknown): value is SessionErrorCode {
  return typeof value === "string" && (SESSION_ERROR_CODES as readonly string[]).includes(value);
}

export function isSessionType(value: unknown): value is SessionType {
  return typeof value === "string" && (SESSION_TYPES as readonly string[]).includes(value);
}

export function isSessionSource(value: unknown): value is SessionSource {
  return typeof value === "string" && (SESSION_SOURCES as readonly string[]).includes(value);
}

export function isUserRole(value: unknown): value is UserRole {
  return typeof value === "string" && (USER_ROLES as readonly string[]).includes(value);
}

export function isWorktreeStatus(value: unknown): value is WorktreeStatus {
  return typeof value === "string" && (WORKTREE_STATUSES as readonly string[]).includes(value);
}

/** Internal deletion leases share the concurrency-lock table but reserve this namespace. */
export function isReservedConcurrencyId(value: string): boolean {
  return value.startsWith("catalog-delete:") || value.startsWith("provider-account:");
}

/** Validate fields required to create a session (control-plane create path). */
export function validateCreateSessionInput(input: {
  repositoryId: unknown;
  prompt: unknown;
  target?: unknown;
  fallbacks?: unknown;
  queueTtlSeconds?: unknown;
  timeout: unknown;
  priority?: unknown;
  requiredLabels?: unknown;
  ref?: unknown;
  concurrencyId?: unknown;
  metadata?: unknown;
  type?: unknown;
  source?: unknown;
}): ValidationResult<{
  repositoryId: string;
  prompt: string;
  target: TargetRef;
  fallbacks: TargetRef[];
  queueTtlSeconds: number;
  timeout: number;
  priority: number;
  requiredLabels: string[];
  ref: string | undefined;
  concurrencyId: string | undefined;
  metadata: Record<string, unknown> | undefined;
  type: SessionType;
  source: SessionSource;
}> {
  if (!isNonEmptyString(input.repositoryId)) {
    return { ok: false, error: "repositoryId is required" };
  }
  if (typeof input.prompt !== "string") {
    return { ok: false, error: "prompt is required" };
  }
  // Scheduled fires use the stored schedule prompt, which may be blank.
  if (!input.prompt && input.type !== "scheduled") {
    return { ok: false, error: "prompt is required" };
  }
  const promptBytes = promptByteLengthError(input.prompt);
  if (promptBytes) return { ok: false, error: promptBytes };
  const routing = validateTargetRouting(input);
  if (!routing.ok) return routing;
  if (typeof input.timeout !== "number" || !Number.isFinite(input.timeout) || input.timeout <= 0) {
    return { ok: false, error: "timeout must be a positive number of seconds" };
  }
  if (input.timeout > MAX_SESSION_TIMEOUT_SECONDS) {
    return { ok: false, error: `timeout must be at most ${MAX_SESSION_TIMEOUT_SECONDS} seconds` };
  }

  let priority = 0;
  if (input.priority !== undefined) {
    if (typeof input.priority !== "number" || !Number.isFinite(input.priority)) {
      return { ok: false, error: "priority must be a number" };
    }
    if (!Number.isInteger(input.priority)) {
      return { ok: false, error: "priority must be an integer" };
    }
    if (Math.abs(input.priority) > MAX_SESSION_PRIORITY) {
      return {
        ok: false,
        error: `priority must be between -${MAX_SESSION_PRIORITY} and ${MAX_SESSION_PRIORITY}`,
      };
    }
    priority = input.priority;
  }

  let requiredLabels: string[] = [];
  if (input.requiredLabels !== undefined) {
    if (
      !Array.isArray(input.requiredLabels) ||
      !input.requiredLabels.every((label) => typeof label === "string")
    ) {
      return { ok: false, error: "requiredLabels must be an array of strings" };
    }
    if (input.requiredLabels.length > MAX_REQUIRED_LABELS) {
      return {
        ok: false,
        error: `requiredLabels must have at most ${MAX_REQUIRED_LABELS} entries`,
      };
    }
    if (input.requiredLabels.some((label) => label.length > MAX_REQUIRED_LABEL_LENGTH)) {
      return {
        ok: false,
        error: `requiredLabels entries must be at most ${MAX_REQUIRED_LABEL_LENGTH} characters`,
      };
    }
    requiredLabels = input.requiredLabels;
  }

  let ref: string | undefined;
  if (input.ref !== undefined) {
    if (!isNonEmptyString(input.ref)) {
      return { ok: false, error: "ref must be a non-empty string when set" };
    }
    // Reject shell/argv-hostile shapes for every session, not only scheduled ones — a
    // manual ref reaches `git rev-parse`/`git switch` in worktree-manager.ts too.
    if (!isValidSessionRef(input.ref)) {
      return { ok: false, error: "ref must be a valid git ref" };
    }
    ref = input.ref;
  }

  let concurrencyId: string | undefined;
  if (input.concurrencyId !== undefined) {
    if (!isNonEmptyString(input.concurrencyId)) {
      return { ok: false, error: "concurrencyId must be a non-empty string when set" };
    }
    if (isReservedConcurrencyId(input.concurrencyId)) {
      return { ok: false, error: "concurrencyId uses a reserved internal prefix" };
    }
    const concurrencyIdBytes = concurrencyIdByteLengthError(input.concurrencyId);
    if (concurrencyIdBytes) return { ok: false, error: concurrencyIdBytes };
    concurrencyId = input.concurrencyId;
  }

  let metadata: Record<string, unknown> | undefined;
  if (input.metadata !== undefined) {
    const parsed = parseSessionMetadata(input.metadata);
    if (!parsed.ok) return parsed;
    metadata = parsed.value;
  }

  if (input.type !== undefined && !isSessionType(input.type)) {
    return { ok: false, error: "type must be prompt or scheduled" };
  }
  if (input.source !== undefined && !isSessionSource(input.source)) {
    return { ok: false, error: "source must be api, ui, webhook, or schedule" };
  }
  const type = input.type ?? "prompt";
  if (type === "scheduled" && ref !== undefined && !isValidScheduledBranchRef(ref)) {
    return { ok: false, error: "scheduled ref must be a valid branch name" };
  }

  return {
    ok: true,
    value: {
      repositoryId: input.repositoryId,
      prompt: input.prompt,
      target: routing.value.target,
      fallbacks: routing.value.fallbacks,
      queueTtlSeconds: routing.value.queueTtlSeconds,
      timeout: input.timeout,
      priority,
      requiredLabels,
      ref,
      concurrencyId,
      metadata,
      type,
      source: input.source ?? "api",
    },
  };
}

/** Strict routing policy validation shared by sessions and schedules. */
export function validateTargetRouting(input: {
  target?: unknown;
  fallbacks?: unknown;
  queueTtlSeconds?: unknown;
}): ValidationResult<{ target: TargetRef; fallbacks: TargetRef[]; queueTtlSeconds: number }> {
  const target = parseTarget(input.target, "target");
  if (!target.ok) return target;
  const fallbacks: TargetRef[] = [];
  if (input.fallbacks !== undefined) {
    if (!Array.isArray(input.fallbacks)) return { ok: false, error: "fallbacks must be an array" };
    if (input.fallbacks.length > MAX_FALLBACKS) {
      return { ok: false, error: `fallbacks must have at most ${MAX_FALLBACKS} entries` };
    }
    const seen = new Set([targetKey(target.value)]);
    for (let i = 0; i < input.fallbacks.length; i++) {
      const fallback = parseTarget(input.fallbacks[i], `fallbacks[${i}]`);
      if (!fallback.ok) return fallback;
      const key = targetKey(fallback.value);
      if (seen.has(key)) {
        return { ok: false, error: "target and fallbacks must not contain duplicates" };
      }
      seen.add(key);
      fallbacks.push(fallback.value);
    }
  }
  const queueTtlSeconds = input.queueTtlSeconds ?? DEFAULT_QUEUE_TTL_SECONDS;
  if (
    typeof queueTtlSeconds !== "number" ||
    !Number.isInteger(queueTtlSeconds) ||
    queueTtlSeconds <= 0
  ) {
    return { ok: false, error: "queueTtlSeconds must be a positive integer" };
  }
  if (queueTtlSeconds > MAX_QUEUE_TTL_SECONDS) {
    return { ok: false, error: `queueTtlSeconds must be at most ${MAX_QUEUE_TTL_SECONDS}` };
  }
  return { ok: true, value: { target: target.value, fallbacks, queueTtlSeconds } };
}

function parseTarget(value: unknown, name: string): ValidationResult<TargetRef> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      ok: false,
      error: `${name} must be an object with exactly one of providerId or commandId`,
    };
  }
  const target = value as Record<string, unknown>;
  const hasProvider = target.providerId !== undefined;
  const hasCommand = target.commandId !== undefined;
  if (hasProvider === hasCommand) {
    return { ok: false, error: `${name} must contain exactly one of providerId or commandId` };
  }
  if (hasProvider) {
    return isNonEmptyString(target.providerId)
      ? { ok: true, value: { providerId: target.providerId } }
      : { ok: false, error: `${name}.providerId must be a non-empty string` };
  }
  return isNonEmptyString(target.commandId)
    ? { ok: true, value: { commandId: target.commandId } }
    : { ok: false, error: `${name}.commandId must be a non-empty string` };
}

function targetKey(target: TargetRef): string {
  return "providerId" in target ? `provider:${target.providerId}` : `command:${target.commandId}`;
}

function parseSessionMetadata(value: unknown): ValidationResult<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: "metadata must be an object when set" };
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_METADATA_KEYS) {
    return { ok: false, error: `metadata must have at most ${MAX_METADATA_KEYS} keys` };
  }
  for (const [key, field] of entries) {
    if (key.length === 0 || key.length > MAX_METADATA_KEY_LENGTH) {
      return {
        ok: false,
        error: `metadata keys must be 1-${MAX_METADATA_KEY_LENGTH} characters`,
      };
    }
    if (field !== null && typeof field === "object") {
      return { ok: false, error: "metadata values must be strings, numbers, booleans, or null" };
    }
    if (typeof field === "string" && field.length > MAX_METADATA_STRING_LENGTH) {
      return {
        ok: false,
        error: `metadata string values must be at most ${MAX_METADATA_STRING_LENGTH} characters`,
      };
    }
    if (
      field !== null &&
      typeof field !== "string" &&
      typeof field !== "number" &&
      typeof field !== "boolean"
    ) {
      return { ok: false, error: "metadata values must be strings, numbers, booleans, or null" };
    }
  }
  return { ok: true, value: { ...(value as Record<string, unknown>) } };
}

/**
 * Build SessionLog sort key: `<canonical-ISO-timestamp>#<zero-padded-seq>`.
 * Seq is assigned by the agent (docs/plan.md Invariant 5).
 */
export function formatLogSortKey(timestampIso: string, seq: number): string {
  if (!isNonEmptyString(timestampIso)) {
    throw new Error("timestampIso is required");
  }
  if (!Number.isInteger(seq) || seq < 0) {
    throw new Error("seq must be a non-negative integer");
  }
  const timestampMs = Date.parse(timestampIso);
  const canonicalTimestamp = Number.isNaN(timestampMs)
    ? timestampIso
    : new Date(timestampMs).toISOString();
  return `${canonicalTimestamp}#${String(seq).padStart(10, "0")}`;
}
