import { isTerminalSessionStatus } from "@auto-harness/shared";

import { cancelSession } from "./control-plane-lifecycle.ts";
import { getSessionDurable } from "./control-plane-durable-read-runtime.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";
import { toPublic } from "./control-plane-state.ts";
import type { PublicSession } from "./control-plane-types.ts";
import { releaseWorktree } from "./control-plane-worktrees.ts";

/** Persist a queued cancellation and its lock release as one durable transition. */
export async function cancelSessionDurable(
  state: ControlPlaneState,
  id: string,
): Promise<{ ok: true; session: PublicSession } | { ok: false; error: string }> {
  if (!state.storage) return cancelSession(state, id);
  // A cached running scheduled session identifies the exact assignment that
  // this API node observed. Keep that snapshot while reading DynamoDB: a
  // different node can reclaim and reassign the same logical session between
  // those two operations, and a cancellation from this stale node must not
  // terminate the replacement attempt.
  const cached = state.sessions.get(id);
  const expectedAssignment = cached ? { ...cached } : undefined;
  const session = await getSessionDurable(state, id);
  if (!session) return { ok: false, error: "session not found" };
  if (isTerminalSessionStatus(session.status)) {
    return { ok: false, error: `session already terminal: ${session.status}` };
  }
  if (session.status === "running") {
    if (!session.mainCheckoutLease) return cancelSession(state, id);
    const assignment = expectedAssignment ?? session;
    if (
      assignment.status !== "running" ||
      !assignment.mainCheckoutLease ||
      !assignment.hostId ||
      !assignment.assignmentConnectionId ||
      !assignment.attemptId
    ) {
      return { ok: false, error: "session changed before cancellation" };
    }
    const completedAt = state.now();
    const deadlineAt = new Date(Date.parse(completedAt) + state.reconnectGraceMs).toISOString();
    const errorMessage = "cancelled by operator";
    const cancelled = await state.storage.cancelRunningMainCheckoutSession({
      sessionId: id,
      hostId: assignment.hostId,
      connectionId: assignment.assignmentConnectionId,
      attemptId: assignment.attemptId,
      queueShard: assignment.queueShard,
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
    state.sessions.set(id, { ...session });
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
  state.sessions.set(id, { ...session });
  return { ok: true, session: toPublic(state, session) };
}
