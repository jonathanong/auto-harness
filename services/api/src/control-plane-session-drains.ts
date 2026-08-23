/* eslint-disable max-lines */
import { createHash, randomUUID } from "node:crypto";

import {
  isSessionDrainLedgerUnavailable,
  isSessionDrainScopeUnavailable,
  type SessionDrainRecord,
} from "./db/plane-storage.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";
import { cancelSessionDurable } from "./control-plane-cancel-durable.ts";
import { appendAuditLog } from "./control-plane-audit.ts";
import { SYSTEM_AUDIT_ACTOR } from "./audit.ts";

const MAX_CANCELLATIONS_PER_RECONCILE = 100;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,128}$/;

function drainOperationId(
  state: ControlPlaneState,
  repositoryId: string,
  principalId: string,
  idempotencyKey: string | undefined,
): string {
  if (!idempotencyKey) return state.sessionDrainIdFactory();
  return `drain-${createHash("sha256")
    .update(`${repositoryId}\0${principalId}\0${idempotencyKey}`)
    .digest("hex")
    .slice(0, 32)}`;
}

function stillOccupiesScope(session: {
  status: string;
  worktreeId?: string | null;
  mainCheckoutLease?: boolean;
}): boolean {
  return (
    session.status === "queued" ||
    session.status === "running" ||
    (session.status === "cancelled" && (!!session.worktreeId || !!session.mainCheckoutLease))
  );
}

export async function reconcileSessionDrainDurable(
  state: ControlPlaneState,
  initialDrain: SessionDrainRecord,
): Promise<SessionDrainRecord> {
  if (!state.storage || initialDrain.status !== "draining") return initialDrain;
  const drain =
    typeof state.storage.claimSessionDrainReconcile === "function"
      ? await state.storage.claimSessionDrainReconcile(initialDrain, randomUUID(), state.now())
      : initialDrain;
  if (!drain) return initialDrain;
  const listed = await state.storage.listSessionsForDrain(
    drain.repositoryId,
    drain.principalId,
    drain.operationId,
    state.shardCount,
    drain.activityCursor,
  );
  // Test doubles from the pre-pagination adapter return the old array shape.
  const page = (Array.isArray(listed) ? { sessions: listed } : listed) as {
    sessions: import("./db/types.ts").SessionRecord[];
    nextKey?: Record<string, unknown>;
  };
  let cancelledThisPage = 0;
  for (const session of page.sessions
    .filter((candidate) => candidate.status === "queued" || candidate.status === "running")
    .slice(0, MAX_CANCELLATIONS_PER_RECONCILE)) {
    state.sessions.set(session.id, { ...session });
    const result = await cancelSessionDurable(state, session.id, {
      drainOperationId: drain.operationId,
    });
    if (result.ok) {
      cancelledThisPage += 1;
      await appendAuditLog(state, {
        actor: SYSTEM_AUDIT_ACTOR,
        action: "session-drain:cancel",
        resourceType: "session",
        resourceId: session.id,
        repositoryId: drain.repositoryId,
        outcome: "success",
        metadata: { operationId: drain.operationId, principalId: drain.principalId },
      });
    } else {
      await appendAuditLog(state, {
        actor: SYSTEM_AUDIT_ACTOR,
        action: "session-drain:cancel",
        resourceType: "session",
        resourceId: session.id,
        repositoryId: drain.repositoryId,
        outcome: "failed",
        metadata: { operationId: drain.operationId, principalId: drain.principalId },
      });
    }
  }

  const authoritative = page.sessions;
  const queuedCount = authoritative.filter((session) => session.status === "queued").length;
  // ACT members are removed after a strong read proves their terminal state.
  // Retain the durable monotonic total after cleanup rather than treating the
  // next reconciliation's smaller live set as a conflicting regression.
  const cancelledCount = Math.max(
    drain.cancelledCount + cancelledThisPage,
    authoritative.filter(
      (session) =>
        session.status === "cancelled" && session.cancelledByDrainOperationId === drain.operationId,
    ).length,
  );
  const runningCount = authoritative.filter(
    (session) =>
      session.status === "running" ||
      (session.status === "cancelled" && (!!session.worktreeId || !!session.mainCheckoutLease)),
  ).length;
  const now = state.now();
  // A final page following an earlier cursor cannot prove that older members
  // are gone. Reset and require a complete fresh strong sweep before terminal
  // success; admission is fenced so the membership cannot grow meanwhile.
  const completeSweep = !page.nextKey && drain.activityCursor === undefined;
  const quiescent = completeSweep && !authoritative.some(stillOccupiesScope);
  const expired = Date.parse(now) >= Date.parse(drain.deadlineAt);
  const updated: SessionDrainRecord = {
    ...drain,
    recordKey: drain.operationId,
    updatedAt: now,
    queuedCount,
    runningCount,
    cancelledCount,
    ...(page.nextKey ? { activityCursor: page.nextKey } : {}),
    ...(quiescent ? { status: "succeeded", completedAt: now } : {}),
    ...(!quiescent && expired
      ? { status: "failed", completedAt: now, failureCode: "DEADLINE_EXCEEDED" }
      : {}),
  };
  if (!page.nextKey && !quiescent && drain.activityCursor !== undefined) {
    delete updated.activityCursor;
  }
  if (!(await state.storage.updateSessionDrain(updated))) {
    return (
      (await state.storage.getSessionDrainOperation(
        drain.repositoryId,
        drain.principalId,
        drain.operationId,
      )) ?? updated
    );
  }
  if (updated.status !== "draining") {
    await appendAuditLog(state, {
      actor: SYSTEM_AUDIT_ACTOR,
      action: updated.status === "succeeded" ? "session-drain:succeeded" : "session-drain:failed",
      resourceType: "repository",
      resourceId: drain.repositoryId,
      repositoryId: drain.repositoryId,
      outcome: updated.status === "succeeded" ? "success" : "failed",
      metadata: {
        operationId: drain.operationId,
        principalId: drain.principalId,
        queuedCount,
        runningCount,
        cancelledCount,
        ...(updated.failureCode ? { failureCode: updated.failureCode } : {}),
      },
    });
  }
  return updated;
}

/** Continue every durable drain even when the initiating caller stops polling. */
export async function reconcileSessionDrainsDurable(
  state: ControlPlaneState,
): Promise<SessionDrainRecord[]> {
  if (!state.storage) return [];
  const active =
    typeof state.storage.listSessionDrainReconcileCandidates === "function"
      ? await state.storage.listSessionDrainReconcileCandidates()
      : (await state.storage.listSessionDrains()).filter(
          (drain) => drain.recordKey === "CURRENT" && drain.status === "draining",
        );
  const reconciled: SessionDrainRecord[] = [];
  for (const drain of active) reconciled.push(await reconcileSessionDrainDurable(state, drain));
  return reconciled;
}

export async function createSessionDrainDurable(
  state: ControlPlaneState,
  repositoryId: string,
  principalId: string,
  idempotencyKey?: string,
): Promise<{ created: boolean; drain: SessionDrainRecord } | { error: string; code: string }> {
  if (!state.storage) return { error: "durable storage is required", code: "DURABLE_REQUIRED" };
  if (idempotencyKey !== undefined && !IDEMPOTENCY_KEY.test(idempotencyKey)) {
    return { error: "invalid Idempotency-Key", code: "VALIDATION_ERROR" };
  }
  if (!(await state.storage.getRepository(repositoryId))) {
    return { error: "repository not found", code: "NOT_FOUND" };
  }
  const requestedAt = state.now();
  const operationId = drainOperationId(state, repositoryId, principalId, idempotencyKey);
  const record: SessionDrainRecord = {
    scopeKey: "",
    recordKey: operationId,
    operationId,
    repositoryId,
    principalId,
    status: "draining",
    requestedAt,
    updatedAt: requestedAt,
    deadlineAt: new Date(Date.parse(requestedAt) + state.sessionDrainTimeoutMs).toISOString(),
    queuedCount: 0,
    runningCount: 0,
    cancelledCount: 0,
  };
  let result: { created: boolean; drain: SessionDrainRecord };
  try {
    result = await state.storage.createOrGetSessionDrain(record);
  } catch (error) {
    if (isSessionDrainLedgerUnavailable(error)) {
      return {
        error: "session drain activity ledger is still preparing",
        code: "DRAIN_LEDGER_NOT_READY",
      };
    }
    if (!isSessionDrainScopeUnavailable(error)) throw error;
    if (!(await state.storage.getRepository(repositoryId))) {
      return { error: "repository not found", code: "NOT_FOUND" };
    }
    return { error: "repository deletion is in progress", code: "CONFLICT" };
  }
  return {
    created: result.created,
    drain: await reconcileSessionDrainDurable(state, result.drain),
  };
}

export async function getSessionDrainDurable(
  state: ControlPlaneState,
  repositoryId: string,
  principalId: string,
  operationId: string,
): Promise<SessionDrainRecord | null> {
  if (!state.storage) return null;
  const drain = await state.storage.getSessionDrainOperation(
    repositoryId,
    principalId,
    operationId,
  );
  return drain?.status === "draining" ? reconcileSessionDrainDurable(state, drain) : drain;
}

export async function releaseSessionDrainDurable(
  state: ControlPlaneState,
  repositoryId: string,
  principalId: string,
  operationId: string,
): Promise<SessionDrainRecord | null> {
  if (!state.storage) return null;
  return state.storage.releaseSessionDrain(repositoryId, principalId, operationId, state.now());
}
