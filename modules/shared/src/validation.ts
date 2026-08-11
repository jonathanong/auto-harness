/* eslint-disable max-lines */
import {
  ACTIVE_SESSION_STATUSES,
  SESSION_ERROR_CODES,
  SESSION_SOURCES,
  SESSION_STATUSES,
  TERMINAL_SESSION_STATUSES,
  SESSION_TYPES,
  DEFAULT_QUEUE_TTL_SECONDS,
} from "./constants.ts";
import type { SessionErrorCode, SessionSource, SessionStatus, SessionType } from "./types.ts";
import { isValidScheduledBranchRef } from "./scheduled-branch-ref.ts";
import type { TargetRef } from "./session.ts";

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function isSessionStatus(value: unknown): value is SessionStatus {
  return typeof value === "string" && (SESSION_STATUSES as readonly string[]).includes(value);
}

export function isTerminalSessionStatus(value: unknown): value is SessionStatus {
  return (
    typeof value === "string" && (TERMINAL_SESSION_STATUSES as readonly string[]).includes(value)
  );
}

export function isActiveSessionStatus(value: unknown): value is SessionStatus {
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

/** Internal deletion leases share the concurrency-lock table but reserve this namespace. */
export function isReservedConcurrencyId(value: string): boolean {
  return value.startsWith("catalog-delete:");
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
  if (!isNonEmptyString(input.prompt)) {
    return { ok: false, error: "prompt is required" };
  }
  const routing = validateTargetRouting(input);
  if (!routing.ok) return routing;
  if (typeof input.timeout !== "number" || !Number.isFinite(input.timeout) || input.timeout <= 0) {
    return { ok: false, error: "timeout must be a positive number of seconds" };
  }

  let priority = 0;
  if (input.priority !== undefined) {
    if (typeof input.priority !== "number" || !Number.isFinite(input.priority)) {
      return { ok: false, error: "priority must be a number" };
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
    requiredLabels = input.requiredLabels;
  }

  let ref: string | undefined;
  if (input.ref !== undefined) {
    if (!isNonEmptyString(input.ref)) {
      return { ok: false, error: "ref must be a non-empty string when set" };
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
    concurrencyId = input.concurrencyId;
  }

  let metadata: Record<string, unknown> | undefined;
  if (input.metadata !== undefined) {
    if (
      typeof input.metadata !== "object" ||
      input.metadata === null ||
      Array.isArray(input.metadata)
    ) {
      return { ok: false, error: "metadata must be an object when set" };
    }
    metadata = input.metadata as Record<string, unknown>;
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

/**
 * Build SessionLog sort key: `<ISO-timestamp>#<zero-padded-seq>`.
 * Seq is assigned by the agent (docs/plan.md Invariant 5).
 */
export function formatLogSortKey(timestampIso: string, seq: number): string {
  if (!isNonEmptyString(timestampIso)) {
    throw new Error("timestampIso is required");
  }
  if (!Number.isInteger(seq) || seq < 0) {
    throw new Error("seq must be a non-negative integer");
  }
  return `${timestampIso}#${String(seq).padStart(10, "0")}`;
}
