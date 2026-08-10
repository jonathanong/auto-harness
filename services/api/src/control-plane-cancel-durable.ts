import { isTerminalSessionStatus } from "@auto-harness/shared";

import { cancelSession } from "./control-plane-lifecycle.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";
import { toPublic } from "./control-plane-state.ts";
import type { PublicSession } from "./control-plane-types.ts";
import { releaseWorktree } from "./control-plane-worktrees.ts";
import { getSessionDurable } from "./control-plane-durable-read-runtime.ts";

/** Persist a queued cancellation and its lock release as one durable transition. */
export async function cancelSessionDurable(
  state: ControlPlaneState,
  id: string,
): Promise<{ ok: true; session: PublicSession } | { ok: false; error: string }> {
  if (!state.storage) return cancelSession(state, id);
  const session = await getSessionDurable(state, id);
  if (!session) return { ok: false, error: "session not found" };
  if (isTerminalSessionStatus(session.status)) {
    return { ok: false, error: `session already terminal: ${session.status}` };
  }
  if (session.status === "running") {
    if (!session.mainCheckoutLease) return cancelSession(state, id);
    if (!session.hostId || !session.assignmentConnectionId || !session.attemptId) {
      return { ok: false, error: "running session is missing its assignment fence" };
    }
    const completedAt = state.now();
    const deadlineAt = new Date(Date.parse(completedAt) + state.reconnectGraceMs).toISOString();
    const errorMessage = "cancelled by operator";
    const cancelled = await state.storage.cancelRunningMainCheckoutSession({
      sessionId: id,
      hostId: session.hostId,
      connectionId: session.assignmentConnectionId,
      attemptId: session.attemptId,
      queueShard: session.queueShard,
      completedAt,
      deadlineAt,
      errorMessage,
    });
    if (!cancelled) return { ok: false, error: "session changed before cancellation" };
    state.pendingAcks.delete(id);
    session.status = "cancelled";
    session.errorMessage = errorMessage;
    session.completedAt = completedAt;
    session.reconnectDeadlineAt = deadlineAt;
    state.onHostMessage?.(session.hostId, { type: "session:cancel", sessionId: id });
    return { ok: true, session: toPublic(state, session) };
  }

  const completedAt = state.now();
  const errorMessage = "cancelled by operator";
  const cancelled = await state.storage.cancelQueuedSession({
    sessionId: id,
    queueShard: session.queueShard,
    completedAt,
    errorMessage,
    ...(session.concurrencyId ? { concurrencyId: session.concurrencyId } : {}),
  });
  if (!cancelled) return { ok: false, error: "session changed before cancellation" };

  state.pendingAcks.delete(id);
  if (session.worktreeId) releaseWorktree(state, session.worktreeId);
  session.status = "cancelled";
  session.errorMessage = errorMessage;
  session.completedAt = completedAt;
  session.worktreeId = null;
  session.hostId = null;
  return { ok: true, session: toPublic(state, session) };
}
