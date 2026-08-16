import { isActiveSessionStatus, isTerminalSessionStatus } from "@auto-harness/shared";

import type { SessionRecord } from "./db/types.ts";
import type { PublicSession } from "./control-plane-types.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";
import { hashString, persistSession, toPublic } from "./control-plane-state.ts";

const DEFAULT_CONTINUATION_PROMPT = "Continue from the previous session.";

export type ResumeOptions = {
  pinExpiresAt?: string;
  prompt?: string;
  timeout?: number;
  priority?: number;
};

function validateResumeOverrides(opts: ResumeOptions): string | null {
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
  return null;
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
  if (!isTerminalSessionStatus(source.status)) {
    return { ok: false, error: "source session must be terminal before resume" };
  }
  if (source.type === "scheduled") {
    return { ok: false, error: "scheduled sessions do not support worktree resume" };
  }
  // Terminal transitions detach host/worktree, so the immutable resolved route
  // is the authoritative native-continuation location.
  const pin = source.resolvedRoute?.hostId || source.hostId || source.pinnedHostId;
  if (!pin) return { ok: false, error: "source session has no agent to pin" };
  if (source.resumeSpec?.resumeArgvTemplate && !source.cliResumeRef) {
    return { ok: false, error: "source session has no captured CLI resume reference" };
  }
  const overrideError = validateResumeOverrides(opts);
  if (overrideError) return { ok: false, error: overrideError };
  if (
    opts.pinExpiresAt !== undefined &&
    (typeof opts.pinExpiresAt !== "string" || !Number.isFinite(Date.parse(opts.pinExpiresAt)))
  ) {
    return { ok: false, error: "pinExpiresAt must be a valid timestamp" };
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
  const resumed: SessionRecord = {
    id,
    repositoryId: source.repositoryId,
    prompt: opts.prompt ?? DEFAULT_CONTINUATION_PROMPT,
    target: source.target,
    fallbacks: [...source.fallbacks],
    targetLabels: [...source.targetLabels],
    queueTtlSeconds: source.queueTtlSeconds,
    queueExpiresAt: new Date(Date.parse(createdAt) + source.queueTtlSeconds * 1000).toISOString(),
    timeout: opts.timeout ?? source.timeout,
    priority: opts.priority ?? source.priority,
    requiredLabels: [...source.requiredLabels],
    status: "queued",
    queueShard: Math.abs(hashString(id)) % state.shardCount,
    createdAt,
    resumedFromSessionId: sessionId,
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
    ...(source.ref !== undefined ? { ref: source.ref } : {}),
    ...(source.cliResumeRef !== undefined ? { cliResumeRef: source.cliResumeRef } : {}),
    ...(source.resumeSpec !== undefined ? { resumeSpec: copyResumeSpec(source.resumeSpec) } : {}),
    ...(source.concurrencyId !== undefined ? { concurrencyId: source.concurrencyId } : {}),
    ...(source.metadata !== undefined ? { metadata: source.metadata } : {}),
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
