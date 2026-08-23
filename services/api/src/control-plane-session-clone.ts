import type { SessionRecord } from "./db/types.ts";
import type { PublicSession } from "./control-plane-types.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";
import { hashString, persistSession, toPublic } from "./control-plane-state.ts";
import { resolveTargetLabels } from "./control-plane-session-target-label.ts";
import { repositoryAdmissionFailure } from "./control-plane-repository-admission-state.ts";

export type CloneOptions = {
  prompt?: string;
  timeout?: number;
  priority?: number;
  /** Set only by the authenticated HTTP route; never copied from the source. */
  createdBy?: string;
};

export type CloneFailure = { ok: false; error: string; code?: string };

function validateCloneOverrides(opts: CloneOptions): string | null {
  const allowed = new Set(["prompt", "timeout", "priority", "createdBy"]);
  if (Object.keys(opts as Record<string, unknown>).some((key) => !allowed.has(key))) {
    return "invalid clone overrides";
  }
  if (opts.prompt !== undefined && (typeof opts.prompt !== "string" || opts.prompt.length === 0)) {
    return "prompt must be a non-empty string";
  }
  if (
    opts.timeout !== undefined &&
    (typeof opts.timeout !== "number" || !Number.isFinite(opts.timeout) || opts.timeout <= 0)
  ) {
    return "timeout must be a positive number of seconds";
  }
  if (
    opts.priority !== undefined &&
    (typeof opts.priority !== "number" || !Number.isFinite(opts.priority))
  ) {
    return "priority must be a number";
  }
  if (opts.createdBy !== undefined && typeof opts.createdBy !== "string") {
    return "createdBy must be a string";
  }
  return null;
}

/** Construct a clean rerun without carrying over execution state. */
export function cloneSession(
  state: ControlPlaneState,
  sessionId: string,
  opts: CloneOptions = {},
): { ok: true; session: PublicSession; created: true } | CloneFailure {
  const prepared = prepareClonedSession(state, sessionId, opts);
  if (!prepared.ok) return prepared;
  persistSession(state, prepared.session);
  return { ok: true, session: toPublic(state, prepared.session), created: true };
}

/** Validate and build a clone without persisting it. */
export function prepareClonedSession(
  state: ControlPlaneState,
  sessionId: string,
  opts: CloneOptions = {},
): { ok: true; session: SessionRecord } | CloneFailure {
  const source = state.sessions.get(sessionId);
  if (!source) return { ok: false, error: "session not found", code: "NOT_FOUND" };
  const admissionFailure = repositoryAdmissionFailure(state, source.repositoryId);
  if (admissionFailure) return admissionFailure;
  const overrideError = validateCloneOverrides(opts);
  if (overrideError) return { ok: false, error: overrideError, code: "VALIDATION_ERROR" };
  const targets = resolveTargetLabels(state, source.target, source.fallbacks);
  if (!targets.ok) return { ok: false, error: targets.error, code: "VALIDATION_ERROR" };
  const id = state.idFactory();
  const createdAt = state.now();
  const session: SessionRecord = {
    id,
    repositoryId: source.repositoryId,
    prompt: opts.prompt ?? source.prompt,
    target: { ...source.target },
    fallbacks: source.fallbacks.map((target) => ({ ...target })),
    targetLabels: targets.labels,
    queueTtlSeconds: source.queueTtlSeconds,
    queueExpiresAt: new Date(Date.parse(createdAt) + source.queueTtlSeconds * 1000).toISOString(),
    timeout: opts.timeout ?? source.timeout,
    priority: opts.priority ?? source.priority,
    requiredLabels: [...source.requiredLabels],
    status: "queued",
    queueShard: Math.abs(hashString(id)) % state.shardCount,
    createdAt,
    ...(source.ref !== undefined ? { ref: source.ref } : {}),
    // A clone is an independent rerun. In particular, do not copy
    // concurrencyId, schedule provenance, audit metadata, or any runtime
    // assignment/lease/log fields from the source.
    ...(opts.createdBy !== undefined ? { metadata: { createdBy: opts.createdBy } } : {}),
    type: "prompt",
    source: "api",
  };
  return { ok: true, session };
}
