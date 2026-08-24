/* eslint-disable max-lines */
import { type HostWireMessage } from "@auto-harness/shared";

import type { WorktreeRecord } from "./db/types.ts";
import type { PublicSession } from "./control-plane-types.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";
import { toPublic } from "./control-plane-state.ts";
import { orderedQueuedSessions } from "./control-plane-ordering.ts";
import { persistTerminalSessionThenReleaseConcurrencyLock } from "./control-plane-concurrency-persistence.ts";
import { releaseWorktree, tryClaimWorktree } from "./control-plane-worktrees.ts";
import { buildProviderCatalog } from "./control-plane-session-target.ts";
import { releaseScheduledLeaseLocal } from "./control-plane-scheduled-assign.ts";
import { queueReconnectSession } from "./control-plane-reconnect-session.ts";
import {
  listQueuedSessionsDurable,
  listWorktreesForRepositoryDurable,
  refreshSchedulerReadModel,
} from "./control-plane-durable-read-runtime.ts";
import { sessionPrincipalId } from "./control-plane-session-owner.ts";
import { planPromptPlacement } from "./queue-placement-planner.ts";
import {
  accountHasLeaseCapacity,
  hostProviderAccountReady,
  providerAccountLeaseWriteOpts,
  releaseProviderAccountLease,
  tryAcquireProviderAccountLeaseLocal,
} from "./control-plane-provider-account-leases.ts";
import type { AssignmentWriteResult } from "./db/plane-storage-types.ts";

/**
 * Assign queued sessions with exclusive worktree claim (Invariant 1).
 * Emits session:assign and tracks ack deadline (Invariant 2).
 */
export function assignQueued(
  state: ControlPlaneState,
): Array<{ session: PublicSession; worktree: WorktreeRecord }> {
  const assigned: Array<{ session: PublicSession; worktree: WorktreeRecord }> = [];
  const nowIso = state.now();
  const nowMs = Date.parse(nowIso);
  const catalog = buildProviderCatalog(state);

  for (const session of orderedQueuedSessions(
    state.sessions.values(),
    state.shardCount,
    "prompt",
  )) {
    let plan = planPromptPlacement(state, catalog, session, nowMs);
    if (plan.action === "clear_pin") {
      clearResumePin(session);
      plan = planPromptPlacement(state, catalog, session, nowMs);
    }
    if (plan.action === "expire") {
      expireQueuedLocal(state, session, nowIso);
      continue;
    }
    if (plan.action !== "assign") continue;
    for (const { worktree: candidate, route } of plan.candidates) {
      if (
        !hostProviderAccountReady(state, candidate.hostId, route.providerAccountId) ||
        !accountHasLeaseCapacity(state, route.providerAccountId)
      ) {
        continue;
      }
      const won = tryClaimWorktree(state, candidate.id, session.id, nowIso);
      if (!won) continue;
      const attemptId = state.attemptIdFactory();
      const lease = tryAcquireProviderAccountLeaseLocal(
        state,
        session,
        route.providerAccountId,
        attemptId,
        candidate.hostId,
      );
      if (route.providerAccountId && !lease) {
        releaseWorktree(state, candidate.id);
        continue;
      }
      session.status = "running";
      session.worktreeId = candidate.id;
      session.hostId = candidate.hostId;
      session.startedAt = nowIso;
      session.resolvedArgv = route.resolvedArgv;
      if (session.resumeSpec === undefined && route.resumeSpec !== undefined) {
        session.resumeSpec = route.resumeSpec;
      }
      session.resolvedRoute = {
        targetIndex: route.targetIndex,
        commandId: route.commandId,
        ...(route.providerAccountId ? { providerAccountId: route.providerAccountId } : {}),
        hostId: candidate.hostId,
        worktreeId: candidate.id,
        attemptId,
      };
      session.attemptId = attemptId;
      if (lease) session.providerAccountLease = lease;
      else delete session.providerAccountLease;
      touchAccount(state, route.providerAccountId, nowIso);
      delete session.ackReceivedAt;
      state.pendingAcks.set(session.id, {
        sessionId: session.id,
        worktreeId: candidate.id,
        attemptId,
        assignedAtMs: nowMs,
      });

      const msg: HostWireMessage = {
        type: "session:assign",
        sessionId: session.id,
        sessionType: "prompt",
        repositoryId: session.repositoryId,
        prompt: session.prompt,
        resolvedArgv: route.resolvedArgv,
        timeout: session.timeout,
        worktreeId: candidate.id,
        assignedAt: nowIso,
        attemptId,
        ...(session.ref !== undefined ? { ref: session.ref } : {}),
        ...(session.metadata !== undefined ? { metadata: session.metadata } : {}),
        ...(session.resumeSpec?.resumeRefCapture
          ? { resumeRefCapture: session.resumeSpec.resumeRefCapture }
          : {}),
        ...(route.providerAccountId ? { providerAccountId: route.providerAccountId } : {}),
        commandId: route.commandId,
        targetIndex: route.targetIndex,
        ...resumeWireFields(session),
      };
      state.onHostMessage?.(candidate.hostId, msg);
      assigned.push({ session: toPublic(state, session), worktree: { ...candidate } });
      break;
    }
  }
  return assigned;
}

/**
 * Durable variant used by API handlers. In storage-backed mode the assignment
 * transaction owns both the session and worktree rows; local maps are changed
 * only after the transaction commits. Storage-less mode intentionally keeps
 * the synchronous compare-and-swap implementation above for CLI/tests.
 */
export async function assignQueuedDurable(
  state: ControlPlaneState,
): Promise<Array<{ session: PublicSession; worktree: WorktreeRecord }>> {
  if (!state.storage) {
    return assignQueued(state);
  }
  if (typeof state.storage.backfillQueuedSessionQueueOrder === "function") {
    await state.storage.backfillQueuedSessionQueueOrder(state.shardCount);
  }
  await refreshSchedulerReadModel(state);
  await listQueuedSessionsDurable(state, "prompt");
  const assigned: Array<{ session: PublicSession; worktree: WorktreeRecord }> = [];
  const nowIso = state.now();
  const nowMs = Date.parse(nowIso);
  const catalog = buildProviderCatalog(state);

  for (const session of orderedQueuedSessions(
    state.sessions.values(),
    state.shardCount,
    "prompt",
  )) {
    await listWorktreesForRepositoryDurable(state, session.repositoryId);
    let plan = planPromptPlacement(state, catalog, session, nowMs);
    if (plan.action === "clear_pin") {
      const cleared = await state.storage.clearResumePin({
        sessionId: session.id,
        pinnedHostId: session.pinnedHostId!,
        pinExpiresAt: session.pinExpiresAt,
      });
      if (!cleared) continue;
      clearResumePin(session);
      plan = planPromptPlacement(state, catalog, session, nowMs);
    }
    if (plan.action === "expire") {
      const expired = await state.storage.expireQueuedSession({
        sessionId: session.id,
        queueShard: session.queueShard,
        queueExpiresAt: session.queueExpiresAt,
        completedAt: nowIso,
        ...(session.concurrencyId ? { concurrencyId: session.concurrencyId } : {}),
      });
      if (expired)
        state.sessions.set(session.id, {
          ...session,
          status: "failed",
          completedAt: nowIso,
          errorCode: "queue_expired",
          errorMessage: "queue TTL expired before capacity became available",
        });
      continue;
    }
    if (plan.action !== "assign") continue;
    for (const { worktree: candidate, route } of plan.candidates) {
      const connectionId = state.hostConnection.get(candidate.hostId);
      if (!connectionId) {
        continue;
      }
      if (
        !hostProviderAccountReady(state, candidate.hostId, route.providerAccountId) ||
        !accountHasLeaseCapacity(state, route.providerAccountId)
      ) {
        continue;
      }
      const attemptId = state.attemptIdFactory();
      const occupiedSlots = new Set<number>();
      let lease: ReturnType<typeof tryAcquireProviderAccountLeaseLocal>;
      let won: AssignmentWriteResult = false;
      const principalId = sessionPrincipalId(session);
      while (true) {
        lease = tryAcquireProviderAccountLeaseLocal(
          state,
          session,
          route.providerAccountId,
          attemptId,
          candidate.hostId,
          occupiedSlots,
          false,
        );
        if (route.providerAccountId && !lease) {
          break;
        }
        won = await state.storage.tryAssignSession({
          sessionId: session.id,
          repositoryId: session.repositoryId,
          worktreeId: candidate.id,
          hostId: candidate.hostId,
          ...(principalId ? { principalId } : {}),
          hostInventoryVersion: state.hostInventories.has(candidate.hostId)
            ? (state.hostInventories.get(candidate.hostId)!.version ?? 0)
            : null,
          connectionId,
          now: nowIso,
          resolvedArgv: route.resolvedArgv,
          resumeSpec: route.resumeSpec,
          resolvedRoute: {
            targetIndex: route.targetIndex,
            commandId: route.commandId,
            ...(route.providerAccountId ? { providerAccountId: route.providerAccountId } : {}),
            hostId: candidate.hostId,
            worktreeId: candidate.id,
            attemptId,
          },
          attemptId,
          ...(route.providerAccountId ? { providerAccountId: route.providerAccountId } : {}),
          ...(lease ? { providerAccountLease: lease } : {}),
          queueShard: session.queueShard,
        });
        if (won === true || !lease) break;
        state.providerAccountLeases.delete(lease.concurrencyId);
        if (won !== "lease_collision") break;
        occupiedSlots.add(lease.slot);
      }
      if (won !== true) continue;
      const resumeSpec = session.resumeSpec ?? route.resumeSpec;
      const nextSession = {
        ...session,
        status: "running" as const,
        worktreeId: candidate.id,
        hostId: candidate.hostId,
        startedAt: nowIso,
        resolvedArgv: route.resolvedArgv,
        resumeSpec,
        resolvedRoute: {
          targetIndex: route.targetIndex,
          commandId: route.commandId,
          ...(route.providerAccountId ? { providerAccountId: route.providerAccountId } : {}),
          hostId: candidate.hostId,
          worktreeId: candidate.id,
          attemptId,
        },
        attemptId,
        ...(lease ? { providerAccountLease: lease } : {}),
      };
      const nextWorktree = {
        ...candidate,
        status: "busy" as const,
        currentSessionId: session.id,
        lastAssignedAt: nowIso,
      };
      state.sessions.set(session.id, nextSession);
      touchAccount(state, route.providerAccountId, nowIso);
      state.worktrees.set(candidate.id, nextWorktree);
      state.pendingAcks.set(session.id, {
        sessionId: session.id,
        worktreeId: candidate.id,
        attemptId,
        assignedAtMs: nowMs,
      });
      const msg: HostWireMessage = {
        type: "session:assign",
        sessionId: session.id,
        sessionType: "prompt",
        repositoryId: session.repositoryId,
        prompt: session.prompt,
        resolvedArgv: route.resolvedArgv,
        timeout: session.timeout,
        worktreeId: candidate.id,
        assignedAt: nowIso,
        attemptId,
        ...(session.ref !== undefined ? { ref: session.ref } : {}),
        ...(session.metadata !== undefined ? { metadata: session.metadata } : {}),
        ...(nextSession.resumeSpec?.resumeRefCapture
          ? { resumeRefCapture: nextSession.resumeSpec.resumeRefCapture }
          : {}),
        ...(route.providerAccountId ? { providerAccountId: route.providerAccountId } : {}),
        commandId: route.commandId,
        targetIndex: route.targetIndex,
        ...resumeWireFields(session),
      };
      state.onHostMessage?.(candidate.hostId, msg);
      assigned.push({ session: toPublic(state, nextSession), worktree: { ...nextWorktree } });
      break;
    }
  }
  return assigned;
}

function touchAccount(state: ControlPlaneState, id: string | undefined, at: string): void {
  if (!id) return;
  const account = state.providerAccounts.get(id);
  if (!account) return;
  const next = { ...account, lastAssignedAt: at, updatedAt: at };
  state.providerAccounts.set(id, next);
}

function clearResumePin(session: import("./db/types.ts").SessionRecord): void {
  delete session.pinnedHostId;
  delete session.pinnedProviderAccountId;
  delete session.pinnedTargetIndex;
  delete session.pinnedCommandId;
  delete session.pinExpiresAt;
  delete session.cliResumeRef;
  session.resumeFallback = true;
}

function resumeWireFields(session: import("./db/types.ts").SessionRecord): {
  resumedFromSessionId?: string;
  resume?: true;
  cliResumeRef?: string;
} {
  if (!session.resumedFromSessionId) return {};
  return {
    resumedFromSessionId: session.resumedFromSessionId,
    ...(session.resumeFallback
      ? {}
      : {
          resume: true as const,
          cliResumeRef: session.cliResumeRef!,
        }),
  };
}

function expireQueuedLocal(
  state: ControlPlaneState,
  session: import("./db/types.ts").SessionRecord,
  nowIso: string,
): void {
  session.status = "failed";
  session.errorCode = "queue_expired";
  session.errorMessage = "queue TTL expired before capacity became available";
  session.completedAt = nowIso;
  persistExpired(state, session);
}

function persistExpired(
  state: ControlPlaneState,
  session: import("./db/types.ts").SessionRecord,
): void {
  if (session.concurrencyId && state.storage) {
    persistTerminalSessionThenReleaseConcurrencyLock(
      state,
      session,
      session.concurrencyId,
      state.storage,
    );
    return;
  }
  state.sessions.set(session.id, { ...session });
  if (state.storage) void state.storage.putSession({ ...session });
}

/** Invariant 2: requeue sessions that never acked. */
export function enforceAckDeadlines(
  state: ControlPlaneState,
  nowMs: number = Date.now(),
): string[] {
  const requeued: string[] = [];
  for (const [sessionId, pending] of state.pendingAcks) {
    if (nowMs - pending.assignedAtMs < state.ackDeadlineMs) {
      continue;
    }
    const session = state.sessions.get(sessionId);
    if (
      !session ||
      session.ackReceivedAt ||
      session.worktreeId !== pending.worktreeId ||
      session.attemptId !== pending.attemptId
    ) {
      state.pendingAcks.delete(sessionId);
      continue;
    }
    if (pending.worktreeId) releaseWorktree(state, pending.worktreeId);
    else releaseScheduledLeaseLocal(state, session);
    releaseProviderAccountLease(state, session);
    if (!pending.worktreeId)
      state.sessions.set(
        sessionId,
        queueReconnectSession(session, "agent did not acknowledge assignment; requeued"),
      );
    else {
      session.status = "queued";
      session.worktreeId = null;
      session.hostId = null;
      delete session.startedAt;
    }
    state.pendingAcks.delete(sessionId);
    requeued.push(sessionId);
  }
  return requeued;
}

/** Durable ack-deadline requeue. */
export async function enforceAckDeadlinesDurable(
  state: ControlPlaneState,
  nowMs: number = Date.now(),
): Promise<string[]> {
  if (!state.storage) {
    return enforceAckDeadlines(state, nowMs);
  }
  const durableSessions =
    typeof state.storage.listAllSessions === "function"
      ? await state.storage.listAllSessions()
      : [];
  for (const session of durableSessions) {
    if (
      session.type === "scheduled" &&
      session.status === "running" &&
      !session.ackReceivedAt &&
      session.assignmentSentAt &&
      session.attemptId &&
      !state.pendingAcks.has(session.id)
    ) {
      state.sessions.set(session.id, session);
      state.pendingAcks.set(session.id, {
        sessionId: session.id,
        worktreeId: null,
        attemptId: session.attemptId,
        assignedAtMs: Date.parse(session.assignmentSentAt),
      });
    }
  }
  const requeued: string[] = [];
  for (const [sessionId, pending] of state.pendingAcks) {
    if (nowMs - pending.assignedAtMs < state.ackDeadlineMs) {
      continue;
    }
    const session = state.sessions.get(sessionId);
    if (
      !session ||
      session.ackReceivedAt ||
      session.worktreeId !== pending.worktreeId ||
      session.attemptId !== pending.attemptId
    ) {
      state.pendingAcks.delete(sessionId);
      continue;
    }
    const won = pending.worktreeId
      ? await state.storage.tryRequeueSession({
          sessionId,
          worktreeId: pending.worktreeId,
          attemptId: pending.attemptId,
          queueShard: session.queueShard,
          reason: "agent did not acknowledge assignment; requeued",
          requireUnacknowledged: true,
          ...providerAccountLeaseWriteOpts(session),
        })
      : session.hostId && session.assignmentConnectionId
        ? await state.storage.releaseMainCheckoutSession({
            sessionId,
            hostId: session.hostId,
            repositoryId: session.repositoryId,
            connectionId: session.assignmentConnectionId,
            attemptId: pending.attemptId,
            status: "queued",
            queueShard: session.queueShard,
            reason: "agent did not acknowledge assignment; requeued",
            requireUnacknowledged: true,
            ...providerAccountLeaseWriteOpts(session),
          })
        : false;
    if (!won) {
      state.pendingAcks.delete(sessionId);
      continue;
    }
    const wt = pending.worktreeId ? state.worktrees.get(pending.worktreeId) : undefined;
    if (wt && pending.worktreeId) {
      state.worktrees.set(pending.worktreeId, {
        ...wt,
        status: "idle",
        currentSessionId: null,
      });
    }
    const reason = "agent did not acknowledge assignment; requeued";
    releaseProviderAccountLease(state, session);
    const queued = pending.worktreeId
      ? {
          ...session,
          status: "queued" as const,
          worktreeId: null,
          hostId: null,
          errorMessage: reason,
        }
      : queueReconnectSession(session, reason);
    delete queued.providerAccountLease;
    state.sessions.set(sessionId, queued);
    if (!pending.worktreeId) releaseScheduledLeaseLocal(state, session);
    state.pendingAcks.delete(sessionId);
    requeued.push(sessionId);
  }
  return requeued;
}
