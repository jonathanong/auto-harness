import {
  ON_CONFLICT_OPTIONS,
  SESSION_ERROR_CODES,
  SESSION_SOURCES,
  SESSION_STATUSES,
  TERMINAL_SESSION_STATUSES,
  SESSION_TYPES,
} from "./constants.ts";
import type {
  OnConflict,
  SessionErrorCode,
  SessionSource,
  SessionStatus,
  SessionType,
} from "./types.ts";
import { isValidScheduledBranchRef } from "./scheduled-branch-ref.ts";

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

export function isSessionErrorCode(value: unknown): value is SessionErrorCode {
  return typeof value === "string" && (SESSION_ERROR_CODES as readonly string[]).includes(value);
}

export function isOnConflict(value: unknown): value is OnConflict {
  return typeof value === "string" && (ON_CONFLICT_OPTIONS as readonly string[]).includes(value);
}

export function isSessionType(value: unknown): value is SessionType {
  return typeof value === "string" && (SESSION_TYPES as readonly string[]).includes(value);
}

export function isSessionSource(value: unknown): value is SessionSource {
  return typeof value === "string" && (SESSION_SOURCES as readonly string[]).includes(value);
}

/** Validate fields required to create a session (control-plane create path). */
export function validateCreateSessionInput(input: {
  repositoryId: unknown;
  prompt: unknown;
  providerAccountId?: unknown;
  commandId?: unknown;
  timeout: unknown;
  priority?: unknown;
  requiredLabels?: unknown;
  onConflict?: unknown;
  ref?: unknown;
  concurrencyKey?: unknown;
  metadata?: unknown;
  type?: unknown;
  source?: unknown;
}): ValidationResult<{
  repositoryId: string;
  prompt: string;
  providerAccountId: string | undefined;
  commandId: string | undefined;
  timeout: number;
  priority: number;
  requiredLabels: string[];
  onConflict: OnConflict;
  ref: string | undefined;
  concurrencyKey: string | undefined;
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
  if ((input.providerAccountId !== undefined) === (input.commandId !== undefined)) {
    return { ok: false, error: "exactly one of providerAccountId or commandId is required" };
  }
  let providerAccountId: string | undefined;
  let commandId: string | undefined;
  if (input.providerAccountId !== undefined) {
    if (!isNonEmptyString(input.providerAccountId)) {
      return { ok: false, error: "providerAccountId must be a non-empty string" };
    }
    providerAccountId = input.providerAccountId;
  } else {
    if (!isNonEmptyString(input.commandId)) {
      return { ok: false, error: "commandId must be a non-empty string" };
    }
    commandId = input.commandId;
  }
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

  let onConflict: OnConflict = "queue";
  if (input.onConflict !== undefined) {
    if (!isOnConflict(input.onConflict)) {
      return {
        ok: false,
        error: "onConflict must be queue, replace, or reject",
      };
    }
    onConflict = input.onConflict;
  }

  let ref: string | undefined;
  if (input.ref !== undefined) {
    if (!isNonEmptyString(input.ref)) {
      return { ok: false, error: "ref must be a non-empty string when set" };
    }
    ref = input.ref;
  }

  let concurrencyKey: string | undefined;
  if (input.concurrencyKey !== undefined) {
    if (!isNonEmptyString(input.concurrencyKey)) {
      return { ok: false, error: "concurrencyKey must be a non-empty string when set" };
    }
    concurrencyKey = input.concurrencyKey;
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
      providerAccountId,
      commandId,
      timeout: input.timeout,
      priority,
      requiredLabels,
      onConflict,
      ref,
      concurrencyKey,
      metadata,
      type,
      source: input.source ?? "api",
    },
  };
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
