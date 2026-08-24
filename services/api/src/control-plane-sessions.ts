import {
  isActiveSessionStatus,
  isTerminalSessionStatus,
  type SessionStatus,
  validateCreateSessionInput,
} from "@auto-harness/shared";

import type { SessionRecord } from "./db/types.ts";
import type { PublicSession } from "./control-plane-types.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";
import { hashString, persistSession, toPublic } from "./control-plane-state.ts";
import { persistTerminalSessionThenReleaseConcurrencyLock } from "./control-plane-concurrency-persistence.ts";
import { resolveTargetLabels } from "./control-plane-session-target-label.ts";
import { releaseWorktree } from "./control-plane-worktrees.ts";
import { repositoryAdmissionFailure } from "./control-plane-repository-admission-state.ts";
export { resumeSession, type ResumeOptions } from "./control-plane-session-resume.ts";

export {
  listSessions,
  listSessionsPage,
  type ListSessionsPageQuery,
  type ListSessionsPageResult,
} from "./control-plane-sessions-page.ts";

export function createSession(
  state: ControlPlaneState,
  body: unknown,
  options: { allowScheduleId?: boolean } = {},
):
  | { ok: true; session: PublicSession; created: boolean }
  | { ok: false; error: string; code?: string } {
  if (typeof body !== "object" || body === null) {
    return { ok: false, error: "body must be an object" };
  }
  const record = body as Record<string, unknown>;
  const validated = validateCreateSessionInput({
    repositoryId: record.repositoryId,
    prompt: record.prompt,
    target: record.target,
    fallbacks: record.fallbacks,
    queueTtlSeconds: record.queueTtlSeconds,
    timeout: record.timeout,
    priority: record.priority,
    requiredLabels: record.requiredLabels,
    ref: record.ref,
    concurrencyId: record.concurrencyId,
    metadata: record.metadata,
    type: record.type,
    source: record.source,
  });
  if (!validated.ok) {
    return validated;
  }

  const v = validated.value;
  const admissionFailure = repositoryAdmissionFailure(state, v.repositoryId);
  if (admissionFailure) return admissionFailure;
  const targets = resolveTargetLabels(state, v.target, v.fallbacks);
  if (!targets.ok) {
    return { ok: false, error: targets.error, code: "VALIDATION_ERROR" };
  }
  if (v.concurrencyId) {
    const active = [...state.sessions.values()].filter(
      (s) => s.concurrencyId === v.concurrencyId && isActiveSessionStatus(s.status),
    );
    if (active.length > 0) {
      return { ok: true, session: toPublic(state, active[0]!), created: false };
    }
  }

  const id = state.idFactory();
  const createdAt = state.now();
  const queueShard = Math.abs(hashString(id)) % state.shardCount;
  const session: SessionRecord = {
    id,
    repositoryId: v.repositoryId,
    prompt: v.prompt,
    target: v.target,
    fallbacks: v.fallbacks,
    targetLabels: targets.labels,
    queueTtlSeconds: v.queueTtlSeconds,
    queueExpiresAt: new Date(Date.parse(createdAt) + v.queueTtlSeconds * 1000).toISOString(),
    timeout: v.timeout,
    priority: v.priority,
    requiredLabels: v.requiredLabels,
    status: "queued",
    queueShard,
    createdAt,
    ...(v.ref !== undefined ? { ref: v.ref } : {}),
    ...(v.concurrencyId !== undefined ? { concurrencyId: v.concurrencyId } : {}),
    ...(options.allowScheduleId && typeof record.scheduleId === "string"
      ? { scheduleId: record.scheduleId }
      : {}),
    ...(v.metadata !== undefined ? { metadata: v.metadata } : {}),
    type: v.type,
    source: v.source,
  };
  persistSession(state, session);
  return { ok: true, session: toPublic(state, session), created: true };
}

export function getSession(state: ControlPlaneState, id: string): PublicSession | null {
  const s = state.sessions.get(id);
  return s ? toPublic(state, s) : null;
}

/** Local/test helper; does not apply agent status-validation rules. */
export function forceStatus(
  state: ControlPlaneState,
  id: string,
  status: SessionStatus,
): PublicSession | null {
  const s = state.sessions.get(id);
  if (!s) {
    return null;
  }
  s.status = status;
  const storage = state.storage;
  if (s.concurrencyId && isTerminalSessionStatus(status) && storage) {
    persistTerminalSessionThenReleaseConcurrencyLock(state, s, s.concurrencyId, storage);
  } else {
    persistSession(state, s);
  }
  return toPublic(state, s);
}

/** Cancel a queued or running session. */
export function supersedeSession(
  state: ControlPlaneState,
  sessionId: string,
  reason: string,
): void {
  const session = state.sessions.get(sessionId);
  if (!session || (session.status !== "queued" && session.status !== "running")) {
    return;
  }
  state.pendingAcks.delete(sessionId);
  const wasRunning = session.status === "running";
  const hostId = session.hostId;
  const worktreeId = session.worktreeId;
  session.status = "cancelled";
  session.errorMessage = reason;
  session.completedAt = state.now();
  if (wasRunning && hostId) {
    state.onHostMessage?.(hostId, {
      type: "session:cancel",
      sessionId,
      attemptId: session.attemptId!,
    });
    persistSession(state, session);
    return;
  }
  if (worktreeId) {
    releaseWorktree(state, worktreeId);
  }
  session.worktreeId = null;
  session.hostId = null;
  const storage = state.storage;
  if (session.concurrencyId && storage) {
    persistTerminalSessionThenReleaseConcurrencyLock(
      state,
      session,
      session.concurrencyId,
      storage,
    );
  } else {
    persistSession(state, session);
  }
}
