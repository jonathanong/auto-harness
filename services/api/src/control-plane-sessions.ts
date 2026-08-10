import { validateCreateSessionInput, type SessionStatus } from "@auto-harness/shared";

import type { SessionRecord } from "./db/types.ts";
import type { PublicSession } from "./control-plane-types.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";
import { hashString, persistSession, toPublic } from "./control-plane-state.ts";
import { resolveTargetLabels } from "./control-plane-session-target-label.ts";
import { releaseWorktree } from "./control-plane-worktrees.ts";
export { resumeSession } from "./control-plane-session-resume.ts";

export {
  listSessions,
  listSessionsPage,
  type ListSessionsPageQuery,
  type ListSessionsPageResult,
} from "./control-plane-sessions-page.ts";

export function createSession(
  state: ControlPlaneState,
  body: unknown,
): { ok: true; session: PublicSession } | { ok: false; error: string; code?: string } {
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
    onConflict: record.onConflict,
    ref: record.ref,
    concurrencyKey: record.concurrencyKey,
    metadata: record.metadata,
    type: record.type,
    source: record.source,
  });
  if (!validated.ok) {
    return validated;
  }

  const v = validated.value;
  const targets = resolveTargetLabels(state, v.target, v.fallbacks);
  if (!targets.ok) {
    return { ok: false, error: targets.error, code: "VALIDATION_ERROR" };
  }
  // Invariant 9: concurrencyKey resolved at create time for queue|replace|reject.
  if (v.concurrencyKey) {
    const active = [...state.sessions.values()].filter(
      (s) =>
        s.concurrencyKey === v.concurrencyKey && (s.status === "queued" || s.status === "running"),
    );
    if (active.length > 0) {
      if (v.onConflict === "reject") {
        return {
          ok: false,
          error: `concurrencyKey ${v.concurrencyKey} is already active on session ${active[0]!.id}`,
          code: "CONFLICT",
        };
      }
      if (v.onConflict === "replace") {
        for (const prev of active) {
          supersedeSession(state, prev.id, "replaced by newer session with same concurrencyKey");
        }
      }
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
    onConflict: v.onConflict,
    status: "queued",
    queueShard,
    createdAt,
    ...(v.ref !== undefined ? { ref: v.ref } : {}),
    ...(v.concurrencyKey !== undefined ? { concurrencyKey: v.concurrencyKey } : {}),
    ...(v.metadata !== undefined ? { metadata: v.metadata } : {}),
    type: v.type,
    source: v.source,
  };
  persistSession(state, session);
  return { ok: true, session: toPublic(state, session) };
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
  persistSession(state, s);
  return toPublic(state, s);
}

/** Cancel/supersede queued or running session (onConflict:replace). */
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
    state.onHostMessage?.(hostId, { type: "session:cancel", sessionId });
    persistSession(state, session);
    return;
  }
  if (worktreeId) {
    releaseWorktree(state, worktreeId);
  }
  session.worktreeId = null;
  session.hostId = null;
  persistSession(state, session);
}
