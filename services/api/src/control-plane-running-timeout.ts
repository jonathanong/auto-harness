import type { SessionRecord } from "./db/types.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";
import { persistSession } from "./control-plane-state.ts";
import { persistTerminalSessionThenReleaseConcurrencyLock } from "./control-plane-concurrency-persistence.ts";
import { releaseScheduledLeaseLocal } from "./control-plane-scheduled-assign.ts";
import { releaseWorktree } from "./control-plane-worktrees.ts";

const TIMEOUT_ERROR = "session exceeded timeout without a host terminal report";

function isAcknowledgedRunningDue(session: SessionRecord, nowMs: number): boolean {
  if (session.status !== "running" || !session.startedAt || !session.ackReceivedAt) return false;
  const deadlineMs = Date.parse(session.startedAt) + session.timeout * 1000;
  return Number.isFinite(deadlineMs) && nowMs >= deadlineMs;
}

function persistTimedOutSession(state: ControlPlaneState, session: SessionRecord): void {
  const storage = state.storage;
  if (session.concurrencyId && storage) {
    persistTerminalSessionThenReleaseConcurrencyLock(
      state,
      session,
      session.concurrencyId,
      storage,
    );
    return;
  }
  persistSession(state, session);
}

function timeOutAcknowledgedSession(state: ControlPlaneState, session: SessionRecord): void {
  session.status = "timed_out";
  session.errorMessage = TIMEOUT_ERROR;
  session.completedAt = state.now();
  state.pendingAcks.delete(session.id);
  if (session.hostId) {
    state.onHostMessage?.(session.hostId, { type: "session:cancel", sessionId: session.id });
  }
  if (session.mainCheckoutLease) {
    releaseScheduledLeaseLocal(state, session);
    delete session.mainCheckoutLease;
    delete session.assignmentConnectionId;
    delete session.assignmentSentAt;
    delete session.ackReceivedAt;
    delete session.reconnectDeadlineAt;
  } else if (session.worktreeId) {
    const wt = state.worktrees.get(session.worktreeId);
    if (wt?.currentSessionId === session.id) {
      releaseWorktree(state, session.worktreeId);
    }
  }
  session.worktreeId = null;
  session.hostId = null;
  persistTimedOutSession(state, session);
}

function rememberDurableTimeout(
  state: ControlPlaneState,
  session: SessionRecord,
  completedAt: string,
): void {
  const worktreeId = session.worktreeId;
  if (worktreeId) {
    const wt = state.worktrees.get(worktreeId);
    if (wt?.currentSessionId === session.id) {
      state.worktrees.set(worktreeId, { ...wt, status: "idle", currentSessionId: null });
    }
  }
  if (session.mainCheckoutLease) releaseScheduledLeaseLocal(state, session);
  if (session.hostId) {
    state.onHostMessage?.(session.hostId, { type: "session:cancel", sessionId: session.id });
  }
  state.pendingAcks.delete(session.id);
  const next: SessionRecord = {
    ...session,
    status: "timed_out",
    errorMessage: TIMEOUT_ERROR,
    completedAt,
    worktreeId: null,
    hostId: null,
  };
  delete next.mainCheckoutLease;
  delete next.assignmentConnectionId;
  delete next.assignmentSentAt;
  delete next.ackReceivedAt;
  delete next.reconnectDeadlineAt;
  state.sessions.set(session.id, next);
}

function canCommitDurableTimeout(
  storage: NonNullable<ControlPlaneState["storage"]>,
  session: SessionRecord,
): boolean {
  if (session.mainCheckoutLease && session.hostId && session.assignmentConnectionId) {
    return typeof storage.releaseMainCheckoutSession === "function";
  }
  return typeof storage.finishSession === "function" && session.attemptId !== undefined;
}

async function commitDurableTimeout(
  storage: NonNullable<ControlPlaneState["storage"]>,
  session: SessionRecord,
  completedAt: string,
): Promise<boolean> {
  if (session.mainCheckoutLease && session.hostId && session.assignmentConnectionId) {
    return storage.releaseMainCheckoutSession({
      sessionId: session.id,
      hostId: session.hostId,
      repositoryId: session.repositoryId,
      connectionId: session.assignmentConnectionId,
      status: "timed_out",
      queueShard: session.queueShard,
      completedAt,
      reason: TIMEOUT_ERROR,
      ...(session.attemptId !== undefined ? { attemptId: session.attemptId } : {}),
      ...(session.concurrencyId !== undefined ? { concurrencyId: session.concurrencyId } : {}),
    });
  }
  return storage.finishSession({
    sessionId: session.id,
    worktreeId: session.worktreeId ?? null,
    attemptId: session.attemptId!,
    status: "timed_out",
    queueShard: session.queueShard,
    completedAt,
    errorMessage: TIMEOUT_ERROR,
    ...(session.concurrencyId !== undefined ? { concurrencyId: session.concurrencyId } : {}),
  });
}

/**
 * Control-plane bound on an acknowledged running assignment. Host timeout is
 * best-effort; if the process-exit/status report is lost, this sweep still
 * terminates the public session no later than startedAt + timeout.
 */
export function enforceRunningTimeouts(
  state: ControlPlaneState,
  nowMs: number = Date.now(),
): string[] {
  const timedOut: string[] = [];
  for (const session of state.sessions.values()) {
    if (!isAcknowledgedRunningDue(session, nowMs)) continue;
    timeOutAcknowledgedSession(state, session);
    timedOut.push(session.id);
  }
  return timedOut;
}

export async function enforceRunningTimeoutsDurable(
  state: ControlPlaneState,
  nowMs: number = Date.now(),
): Promise<string[]> {
  const storage = state.storage;
  if (!storage) return enforceRunningTimeouts(state, nowMs);
  const rows =
    typeof storage.listAllSessions === "function"
      ? await storage.listAllSessions()
      : [...state.sessions.values()];
  const canCommit =
    typeof storage.finishSession === "function" ||
    typeof storage.releaseMainCheckoutSession === "function";
  if (!canCommit) {
    for (const session of rows) {
      if (session.status === "running") state.sessions.set(session.id, session);
    }
    return enforceRunningTimeouts(state, nowMs);
  }
  const timedOut: string[] = [];
  const completedAt = state.now();
  for (const session of rows) {
    if (!isAcknowledgedRunningDue(session, nowMs)) continue;
    if (canCommitDurableTimeout(storage, session)) {
      if (!(await commitDurableTimeout(storage, session, completedAt))) continue;
      rememberDurableTimeout(state, session, completedAt);
    } else {
      const current = state.sessions.get(session.id);
      if (current && current.status !== "running") continue;
      const row = current ?? session;
      state.sessions.set(row.id, row);
      timeOutAcknowledgedSession(state, row);
    }
    timedOut.push(session.id);
  }
  return timedOut;
}
