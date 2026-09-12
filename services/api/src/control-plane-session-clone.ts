import {
  promptByteLengthError,
  sessionPriorityError,
  sessionTimeoutError,
} from "@auto-harness/shared";
import type { SessionRecord } from "./db/types.ts";
import type { PublicSession } from "./control-plane-types.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";
import { hashString, persistSession, toPublic } from "./control-plane-state.ts";
import { resolveTargetDisplayNames } from "./control-plane-session-target-display-name.ts";
import { repositoryAdmissionFailure } from "./control-plane-repository-admission-state.ts";
import { workspaceAssignmentPayloadError } from "./control-plane-session-create.ts";

export type CloneOptions = {
  prompt?: string;
  timeout?: number;
  priority?: number;
  destroyWorkspaceAfter?: boolean;
  /** Set only by the authenticated HTTP route; never copied from the source. */
  createdBy?: string;
};

export type CloneFailure = { ok: false; error: string; code?: string; operationId?: string };

function validateCloneOverrides(opts: CloneOptions): string | null {
  const allowed = new Set(["prompt", "timeout", "priority", "destroyWorkspaceAfter", "createdBy"]);
  if (Object.keys(opts as Record<string, unknown>).some((key) => !allowed.has(key))) {
    return "invalid clone overrides";
  }
  if (opts.prompt !== undefined && (typeof opts.prompt !== "string" || opts.prompt.length === 0)) {
    return "prompt must be a non-empty string";
  }
  if (opts.prompt !== undefined) {
    const promptError = promptByteLengthError(opts.prompt);
    if (promptError) return promptError;
  }
  if (opts.timeout !== undefined) {
    const timeoutError = sessionTimeoutError(opts.timeout);
    if (timeoutError) return timeoutError;
  }
  if (opts.priority !== undefined) {
    const priorityError = sessionPriorityError(opts.priority);
    if (priorityError) return priorityError;
  }
  if (opts.createdBy !== undefined && typeof opts.createdBy !== "string") {
    return "createdBy must be a string";
  }
  if (opts.destroyWorkspaceAfter !== undefined && typeof opts.destroyWorkspaceAfter !== "boolean") {
    return "destroyWorkspaceAfter must be a boolean";
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
  if (source.repositoryId) {
    const admissionFailure = repositoryAdmissionFailure(state, source.repositoryId);
    if (admissionFailure) return admissionFailure;
  } else if (!source.workspacePoolId || !state.workspacePools.has(source.workspacePoolId)) {
    return { ok: false, error: "workspace pool not found", code: "VALIDATION_ERROR" };
  }
  const workspacePool = source.workspacePoolId
    ? state.workspacePools.get(source.workspacePoolId)
    : undefined;
  // A clone is admitted as a new workspace run. Preserve the source's
  // already-approved setup content when it has one; legacy rows without that
  // frozen content must still resolve their selected profile while the pool
  // is available. Never let a removed profile silently become no setup.
  let workspaceSetupScript: string | undefined;
  if (source.workspacePoolId && source.setupProfileId) {
    if (source.workspaceSetupScript !== undefined) {
      workspaceSetupScript = source.workspaceSetupScript;
    } else {
      workspaceSetupScript = workspacePool?.setupProfiles.find(
        (profile) => profile.id === source.setupProfileId,
      )?.script;
      if (workspaceSetupScript === undefined) {
        return { ok: false, error: "workspace setup profile not found", code: "NOT_FOUND" };
      }
    }
  }
  const overrideError = validateCloneOverrides({
    ...opts,
    prompt: opts.prompt ?? source.prompt,
    timeout: opts.timeout ?? source.timeout,
    priority: opts.priority ?? source.priority,
  });
  if (overrideError) return { ok: false, error: overrideError, code: "VALIDATION_ERROR" };
  const targets = resolveTargetDisplayNames(state, source.target, source.fallbacks);
  if (!targets.ok) return { ok: false, error: targets.error, code: "VALIDATION_ERROR" };
  const id = state.idFactory();
  const createdAt = state.now();
  const session: SessionRecord = {
    id,
    repositoryId: source.repositoryId,
    ...(source.workspacePoolId ? { workspacePoolId: source.workspacePoolId } : {}),
    ...(source.setupProfileId ? { setupProfileId: source.setupProfileId } : {}),
    ...(workspaceSetupScript !== undefined ? { workspaceSetupScript } : {}),
    ...(source.workspacePoolId
      ? {
          destroyWorkspaceAfter:
            opts.destroyWorkspaceAfter ?? source.destroyWorkspaceAfter ?? false,
        }
      : {}),
    prompt: opts.prompt ?? source.prompt,
    target: { ...source.target },
    fallbacks: source.fallbacks.map((target) => ({ ...target })),
    targetDisplayNames: targets.displayNames,
    queueTtlSeconds: source.queueTtlSeconds,
    queueExpiresAt: new Date(Date.parse(createdAt) + source.queueTtlSeconds * 1000).toISOString(),
    timeout: opts.timeout ?? source.timeout,
    priority: opts.priority ?? source.priority,
    requiredLabels: source.workspacePoolId ? [] : [...source.requiredLabels],
    status: "queued",
    queueShard: Math.abs(hashString(id)) % state.shardCount,
    createdAt,
    ...(source.repositoryId && source.ref !== undefined ? { ref: source.ref } : {}),
    // A clone is an independent rerun. In particular, do not copy
    // concurrencyId, schedule provenance, audit metadata, or any runtime
    // assignment/lease/log fields from the source.
    ...(opts.createdBy !== undefined ? { metadata: { createdBy: opts.createdBy } } : {}),
    ...(opts.createdBy !== undefined ? { principalId: opts.createdBy } : {}),
    type: source.workspacePoolId ? "workspace" : "prompt",
    source: "api",
  };
  if (session.workspacePoolId) {
    const payloadError = workspaceAssignmentPayloadError(state, {
      ...session,
      workspacePoolId: session.workspacePoolId,
    });
    if (payloadError) {
      return { ok: false, error: payloadError, code: "VALIDATION_ERROR" };
    }
  }
  return { ok: true, session };
}
