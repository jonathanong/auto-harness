/* eslint-disable max-lines */
import { createHash } from "node:crypto";

import type { SessionDrainRecord } from "./db/plane-storage.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";
import { cancelSessionDurable } from "./control-plane-cancel-durable.ts";
import { appendAuditLog } from "./control-plane-audit.ts";
import { SYSTEM_AUDIT_ACTOR } from "./audit.ts";
import { sessionPrincipalId } from "./control-plane-session-owner.ts";

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

function belongsToScope(
  session: {
    repositoryId: string;
    principalId?: string;
    metadata?: Record<string, unknown>;
  },
  repositoryId: string,
  principalId: string,
): boolean {
  return session.repositoryId === repositoryId && sessionPrincipalId(session) === principalId;
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
  drain: SessionDrainRecord,
): Promise<SessionDrainRecord> {
  if (!state.storage || drain.status !== "draining") return drain;
  const sessions = (await state.storage.listAllSessions(true)).filter((session) =>
    belongsToScope(session, drain.repositoryId, drain.principalId),
  );
  for (const session of sessions
    .filter((candidate) => candidate.status === "queued" || candidate.status === "running")
    .slice(0, MAX_CANCELLATIONS_PER_RECONCILE)) {
    state.sessions.set(session.id, { ...session });
    const result = await cancelSessionDurable(state, session.id, {
      drainOperationId: drain.operationId,
    });
    if (result.ok) {
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

  const authoritative = (await state.storage.listAllSessions(true)).filter((session) =>
    belongsToScope(session, drain.repositoryId, drain.principalId),
  );
  const queuedCount = authoritative.filter((session) => session.status === "queued").length;
  const cancelledCount = authoritative.filter(
    (session) =>
      session.status === "cancelled" && session.cancelledByDrainOperationId === drain.operationId,
  ).length;
  const runningCount = authoritative.filter(
    (session) =>
      session.status === "running" ||
      (session.status === "cancelled" && (!!session.worktreeId || !!session.mainCheckoutLease)),
  ).length;
  const now = state.now();
  const quiescent = !authoritative.some(stillOccupiesScope);
  const expired = Date.parse(now) >= Date.parse(drain.deadlineAt);
  const updated: SessionDrainRecord = {
    ...drain,
    recordKey: drain.operationId,
    updatedAt: now,
    queuedCount,
    runningCount,
    cancelledCount,
    ...(quiescent ? { status: "succeeded", completedAt: now } : {}),
    ...(!quiescent && expired
      ? { status: "failed", completedAt: now, failureCode: "DEADLINE_EXCEEDED" }
      : {}),
  };
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
  const active = (await state.storage.listSessionDrains()).filter(
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
  const result = await state.storage.createOrGetSessionDrain(record);
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
