import { persistTerminalSessionThenReleaseConcurrencyLock } from "./control-plane-concurrency-persistence.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";
import { persistSession, toPublic } from "./control-plane-state.ts";
import type { PublicSession } from "./control-plane-types.ts";
import { releaseWorktree } from "./control-plane-worktree-release.ts";
import { planSessionTransition, transitionEffect } from "./session-transition-planner.ts";

/** Cancel a non-terminal session; running holds worktree until late terminal. */
export function cancelSession(
  state: ControlPlaneState,
  id: string,
): { ok: true; session: PublicSession } | { ok: false; error: string } {
  const session = state.sessions.get(id);
  if (!session) return { ok: false, error: "session not found" };
  const plan = planSessionTransition(
    session,
    { type: "cancel" },
    {
      now: state.now(),
      source: "local",
      usageLimitRetryCeiling: state.usageLimitRetryCeiling,
    },
  );
  const rejected = transitionEffect(plan, "reject");
  if (rejected) return { ok: false, error: rejected.error };
  const cancel = transitionEffect(plan, "cancel")!;
  state.pendingAcks.delete(id);
  const hostId = session.hostId;
  const worktreeId = session.worktreeId;
  session.status = "cancelled";
  session.errorMessage = "cancelled by operator";
  session.completedAt = state.now();
  if (cancel.holdAssignment && hostId) {
    state.onHostMessage?.(hostId, { type: "session:cancel", sessionId: id });
    persistSession(state, session);
    return { ok: true, session: toPublic(state, session) };
  }
  if (transitionEffect(plan, "release_worktree") && worktreeId) releaseWorktree(state, worktreeId);
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
  return { ok: true, session: toPublic(state, session) };
}
