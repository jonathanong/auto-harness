/* eslint-disable max-lines -- resume validation, pin invalidation, and record construction share one module. */
import {
  appendPriorContextPointer,
  isActiveSessionStatus,
  isTerminalSessionStatus,
  MAX_SESSION_TIMEOUT_SECONDS,
  promptByteLengthError,
  validateTargetRouting,
  type TargetRef,
} from "@auto-harness/shared";

import type { SessionRecord } from "./db/types.ts";
import type { PublicSession } from "./control-plane-types.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";
import { hashString, persistSession, toPublic } from "./control-plane-state.ts";
import { repositoryAdmissionFailure } from "./control-plane-repository-admission-state.ts";
import { resolveTargetDisplayNames } from "./control-plane-session-target-display-name.ts";

const DEFAULT_CONTINUATION_PROMPT = "Continue from the previous session.";

export type ResumeOptions = {
  principalId?: string;
  pinExpiresAt?: string;
  prompt?: string;
  timeout?: number;
  priority?: number;
  /** A repoint override: replaces the whole route policy, not just the primary
   * target, and invalidates any native-resume pin (see `resumeSession` docs). */
  target?: unknown;
  fallbacks?: unknown;
};

type ResumeRouting = { target: TargetRef; fallbacks: TargetRef[] };

function validatePromptOverride(opts: ResumeOptions): string | undefined {
  if (opts.prompt === undefined) return undefined;
  if (typeof opts.prompt !== "string" || opts.prompt.length === 0) {
    return "prompt must be a non-empty string";
  }
  return promptByteLengthError(opts.prompt) ?? undefined;
}

function validateTimeoutOverride(opts: ResumeOptions): string | undefined {
  if (opts.timeout === undefined) return undefined;
  if (typeof opts.timeout !== "number" || !Number.isFinite(opts.timeout) || opts.timeout <= 0) {
    return "timeout must be a positive number of seconds";
  }
  if (opts.timeout > MAX_SESSION_TIMEOUT_SECONDS) {
    return `timeout must be at most ${MAX_SESSION_TIMEOUT_SECONDS} seconds`;
  }
  return undefined;
}

function validatePriorityOverride(opts: ResumeOptions): string | undefined {
  if (opts.priority === undefined) return undefined;
  if (typeof opts.priority !== "number" || !Number.isFinite(opts.priority)) {
    return "priority must be a number";
  }
  return Number.isInteger(opts.priority) ? undefined : "priority must be an integer";
}

function validateResumeOverrides(
  opts: ResumeOptions,
): { ok: true; routing?: ResumeRouting } | { ok: false; error: string } {
  if (opts.principalId !== undefined && typeof opts.principalId !== "string") {
    return { ok: false, error: "principalId must be a string" };
  }
  const promptError = validatePromptOverride(opts);
  if (promptError) return { ok: false, error: promptError };
  const timeoutError = validateTimeoutOverride(opts);
  if (timeoutError) return { ok: false, error: timeoutError };
  const priorityError = validatePriorityOverride(opts);
  if (priorityError) return { ok: false, error: priorityError };
  if (opts.target === undefined) {
    // An override replaces the whole route policy; inheriting a stale primary in
    // front of a fresh fallback list is exactly the bug a rebind is meant to fix.
    if (opts.fallbacks !== undefined) return { ok: false, error: "fallbacks requires target" };
    return { ok: true };
  }
  const routing = validateTargetRouting({ target: opts.target, fallbacks: opts.fallbacks });
  if (!routing.ok) return routing;
  return {
    ok: true,
    routing: { target: routing.value.target, fallbacks: routing.value.fallbacks },
  };
}

/** Resume: pin agent only (D5); re-checkout via ref later on agent. */
export function resumeSession(
  state: ControlPlaneState,
  sessionId: string,
  opts: ResumeOptions = {},
): { ok: true; session: PublicSession; created: boolean } | { ok: false; error: string } {
  const prepared = prepareResumedSession(state, sessionId, opts);
  if (!prepared.ok) return prepared;
  if (prepared.created) persistSession(state, prepared.session);
  return {
    ok: true,
    session: toPublic(state, prepared.session),
    created: prepared.created,
  };
}

/** Validate and construct a resume without persisting it. */
export function prepareResumedSession(
  state: ControlPlaneState,
  sessionId: string,
  opts: ResumeOptions = {},
): { ok: true; session: SessionRecord; created: boolean } | { ok: false; error: string } {
  const source = state.sessions.get(sessionId);
  if (!source) return { ok: false, error: "session not found" };
  const admissionFailure = repositoryAdmissionFailure(state, source.repositoryId);
  if (admissionFailure) return admissionFailure;
  if (!isTerminalSessionStatus(source.status)) {
    return { ok: false, error: "source session must be terminal before resume" };
  }
  if (source.type === "scheduled") {
    return { ok: false, error: "scheduled sessions do not support worktree resume" };
  }
  const overrides = validateResumeOverrides(opts);
  if (!overrides.ok) return overrides;
  // Terminal transitions detach host/worktree, so the immutable resolved route
  // is the authoritative native-continuation location.
  const pin = source.resolvedRoute?.hostId || source.hostId || source.pinnedHostId;
  if (!pin) return { ok: false, error: "source session has no agent to pin" };
  // A target/fallbacks override discards the native pin outright (see below), so an
  // unresumable-natively source is not fatal here — that reject only protects a
  // *native* continuation, which this path is explicitly not one of.
  if (!overrides.routing && source.resumeSpec?.resumeArgvTemplate && !source.cliResumeRef) {
    return { ok: false, error: "source session has no captured CLI resume reference" };
  }
  if (
    opts.pinExpiresAt !== undefined &&
    (typeof opts.pinExpiresAt !== "string" || !Number.isFinite(Date.parse(opts.pinExpiresAt)))
  ) {
    return { ok: false, error: "pinExpiresAt must be a valid timestamp" };
  }
  let overrideDisplayNames: string[] | undefined;
  if (overrides.routing) {
    const resolved = resolveTargetDisplayNames(
      state,
      overrides.routing.target,
      overrides.routing.fallbacks,
    );
    if (!resolved.ok) return resolved;
    overrideDisplayNames = resolved.displayNames;
  }
  // With durable storage, the lock transaction is authoritative. A process
  // cache can be stale, so it must not decide which active resume is returned.
  if (source.concurrencyId && !state.storage) {
    const active = [...state.sessions.values()].find(
      (session) =>
        session.concurrencyId === source.concurrencyId && isActiveSessionStatus(session.status),
    );
    if (active) return { ok: true, session: active, created: false };
  }
  const id = state.idFactory();
  const createdAt = state.now();
  const pinExpiresAt =
    opts.pinExpiresAt === undefined
      ? new Date(Date.parse(createdAt) + 3600_000).toISOString()
      : opts.pinExpiresAt;
  // An override replaces the whole route policy and invalidates the native pin
  // outright: the frozen `resumeSpec` snapshot is what would otherwise carry a
  // stale (or since-deleted) Command forward regardless of the new target.
  const routingFields = overrides.routing
    ? {
        target: overrides.routing.target,
        fallbacks: overrides.routing.fallbacks,
        targetDisplayNames: overrideDisplayNames!,
        resumeFallback: true as const,
        prompt: appendPriorContextPointer(opts.prompt ?? DEFAULT_CONTINUATION_PROMPT),
      }
    : {
        target: source.target,
        fallbacks: [...source.fallbacks],
        targetDisplayNames: [...source.targetDisplayNames],
        prompt: opts.prompt ?? DEFAULT_CONTINUATION_PROMPT,
        pinnedHostId: pin,
        ...(source.resolvedRoute?.providerAccountId
          ? { pinnedProviderAccountId: source.resolvedRoute.providerAccountId }
          : {}),
        ...(source.resolvedRoute
          ? {
              pinnedTargetIndex: source.resolvedRoute.targetIndex,
              pinnedCommandId: source.resolvedRoute.commandId,
            }
          : {}),
        pinExpiresAt,
        ...(source.cliResumeRef === undefined && source.resumedFromSessionId === undefined
          ? { resumeFallback: true }
          : {}),
        ...(source.cliResumeRef !== undefined ? { cliResumeRef: source.cliResumeRef } : {}),
        ...(source.resumeSpec !== undefined
          ? { resumeSpec: copyResumeSpec(source.resumeSpec) }
          : {}),
      };
  const resumed: SessionRecord = {
    id,
    repositoryId: source.repositoryId,
    ...routingFields,
    queueTtlSeconds: source.queueTtlSeconds,
    queueExpiresAt: new Date(Date.parse(createdAt) + source.queueTtlSeconds * 1000).toISOString(),
    timeout: opts.timeout ?? source.timeout,
    priority: opts.priority ?? source.priority,
    requiredLabels: [...source.requiredLabels],
    status: "queued",
    queueShard: Math.abs(hashString(id)) % state.shardCount,
    createdAt,
    resumedFromSessionId: sessionId,
    ...(source.ref !== undefined ? { ref: source.ref } : {}),
    ...(source.concurrencyId !== undefined ? { concurrencyId: source.concurrencyId } : {}),
    ...(opts.principalId !== undefined
      ? {
          metadata: { ...source.metadata, createdBy: opts.principalId },
          principalId: opts.principalId,
        }
      : {
          ...(source.metadata !== undefined ? { metadata: source.metadata } : {}),
          ...(source.principalId !== undefined
            ? { principalId: source.principalId }
            : typeof source.metadata?.createdBy === "string"
              ? { principalId: source.metadata.createdBy }
              : {}),
        }),
    type: "prompt",
    source: "api",
  };
  return { ok: true, session: resumed, created: true };
}

function copyResumeSpec(source: NonNullable<SessionRecord["resumeSpec"]>) {
  return {
    argv: [...source.argv],
    appendPrompt: source.appendPrompt,
    appendPromptSeparator: source.appendPromptSeparator,
    ...(source.resumeArgvTemplate !== undefined
      ? { resumeArgvTemplate: [...source.resumeArgvTemplate] }
      : {}),
    ...(source.resumeRefCapture !== undefined
      ? { resumeRefCapture: { ...source.resumeRefCapture } }
      : {}),
  };
}
