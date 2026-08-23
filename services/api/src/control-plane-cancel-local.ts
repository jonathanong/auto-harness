import { isTerminalSessionStatus } from "@auto-harness/shared";

import { persistTerminalSessionThenReleaseConcurrencyLock } from "./control-plane-concurrency-persistence.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";
import { persistSession, toPublic } from "./control-plane-state.ts";
import type { PublicSession } from "./control-plane-types.ts";
import { releaseWorktree } from "./control-plane-worktree-release.ts";

/** Cancel a non-terminal session; running holds worktree until late terminal. */
export function cancelSession(
  state: ControlPlaneState,
  id: string,
): { ok: true; session: PublicSession } | { ok: false; error: string } {
  const session = state.sessions.get(id);
  if (!session) return { ok: false, error: "session not found" };
  if (isTerminalSessionStatus(session.status)) {
    return { ok: false, error: `session already terminal: ${session.status}` };
  }
  state.pendingAcks.delete(id);
  const wasRunning = session.status === "running";
  const hostId = session.hostId;
  const worktreeId = session.worktreeId;
  session.status = "cancelled";
  session.errorMessage = "cancelled by operator";
  session.completedAt = state.now();
  if (wasRunning && hostId) {
    state.onHostMessage?.(hostId, { type: "session:cancel", sessionId: id });
    persistSession(state, session);
    return { ok: true, session: toPublic(state, session) };
  }
  if (worktreeId) releaseWorktree(state, worktreeId);
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
