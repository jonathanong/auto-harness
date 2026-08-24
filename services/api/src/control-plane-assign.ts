/* eslint-disable max-lines */
import { type HostWireMessage } from "@auto-harness/shared";

import type { WorktreeRecord } from "./db/types.ts";
import type { PublicSession } from "./control-plane-types.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";
import { toPublic } from "./control-plane-state.ts";
import {
  compareSessionsForQueue,
  compareWorktreesForRoundRobin,
} from "./control-plane-ordering.ts";
import { releaseWorktree, tryClaimWorktree } from "./control-plane-worktrees.ts";
import {
  buildProviderCatalog,
  resolveSessionTargetRouteAt,
} from "./control-plane-session-target.ts";
import { releaseScheduledLeaseLocal } from "./control-plane-scheduled-assign.ts";
import { queueReconnectSession } from "./control-plane-reconnect-session.ts";
import {
  listQueuedSessionsDurable,
  listWorktreesForRepositoryDurable,
  refreshSchedulerReadModel,
} from "./control-plane-durable-read-runtime.ts";
import {
  hostAcceptsNewAssignments,
  hostEnvironmentReady,
} from "./control-plane-host-environment.ts";
import { repositoryAdmissionOpen } from "./control-plane-repository-admission-state.ts";
import { sessionPrincipalId } from "./control-plane-session-owner.ts";

function hostGitReady(state: ControlPlaneState, hostId: string): boolean {
  const connectionId = state.hostConnection.get(hostId);
  return (
    connectionId !== undefined && state.connections.get(connectionId)?.runtime?.gitReady === true
  );
}

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

  for (let shard = 0; shard < state.shardCount; shard++) {
    const queued = [...state.sessions.values()]
      .filter((s) => s.status === "queued" && s.queueShard === shard && s.type !== "scheduled")
      .toSorted(compareSessionsForQueue);

    for (const session of queued) {
      if (Date.parse(session.queueExpiresAt) <= nowMs) {
        session.status = "failed";
        session.errorCode = "queue_expired";
        session.errorMessage = "queue TTL expired before capacity became available";
        session.completedAt = nowIso;
        persistExpired(state, session);
        continue;
      }
      if (!repositoryAdmissionOpen(state.repositories.get(session.repositoryId)?.admissionState))
        continue;
      if (session.hostId && session.worktreeId && session.ackReceivedAt) {
        continue;
      }
      // Resume pin: only assign to pinned agent when set (Invariant 7).
      // Skip draining / disconnected agents (online must stay false for zombies).
      let idle = [...state.worktrees.values()].filter(
        (w) =>
          w.repositoryId === session.repositoryId &&
          w.status === "idle" &&
          w.online &&
          hostGitReady(state, w.hostId) &&
          hostAcceptsNewAssignments(state, w.hostId) &&
          hostEnvironmentReady(state, w.hostId, session.repositoryId) &&
          !state.drainingHosts.has(w.hostId) &&
          !state.disconnectedHosts.has(w.hostId) &&
          session.requiredLabels.every((l) => w.labels.includes(l)),
      );
      if (session.pinnedHostId) {
        if (session.pinExpiresAt && Date.parse(session.pinExpiresAt) < nowMs) {
          clearResumePin(session);
          idle = allIdle(state, session);
        } else {
          idle = idle.filter((w) => w.hostId === session.pinnedHostId);
          const hasNativeRoute =
            session.pinnedTargetIndex !== undefined &&
            idle.some((candidate) =>
              resolveSessionTargetRouteAt(
                state,
                catalog,
                session,
                candidate,
                nowMs,
                session.pinnedTargetIndex!,
              ),
            );
          if (!hasNativeRoute) {
            clearResumePin(session);
            idle = allIdle(state, session);
          }
        }
      }
      idle.sort(compareWorktreesForRoundRobin);

      for (let targetIndex = 0; targetIndex <= session.fallbacks.length; targetIndex++) {
        for (const { candidate, route } of eligibleRoutes(
          state,
          catalog,
          session,
          idle,
          nowMs,
          targetIndex,
        )) {
          const won = tryClaimWorktree(state, candidate.id, session.id, nowIso);
          if (!won) {
            continue;
          }
          const attemptId = state.attemptIdFactory();
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
        if (assigned.at(-1)?.session.id === session.id) break;
      }
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
  await refreshSchedulerReadModel(state);
  await listQueuedSessionsDurable(state, "prompt");
  const assigned: Array<{ session: PublicSession; worktree: WorktreeRecord }> = [];
  const nowIso = state.now();
  const nowMs = Date.parse(nowIso);
  const catalog = buildProviderCatalog(state);

  for (let shard = 0; shard < state.shardCount; shard++) {
    const queued = [...state.sessions.values()]
      .filter((s) => s.status === "queued" && s.queueShard === shard && s.type !== "scheduled")
      .toSorted(compareSessionsForQueue);
    for (const session of queued) {
      if (Date.parse(session.queueExpiresAt) <= nowMs) {
        const expired = await state.storage.expireQueuedSession({
          sessionId: session.id,
          queueShard: session.queueShard,
          queueExpiresAt: session.queueExpiresAt,
          completedAt: nowIso,
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
      if (!repositoryAdmissionOpen(state.repositories.get(session.repositoryId)?.admissionState))
        continue;
      await listWorktreesForRepositoryDurable(state, session.repositoryId);
      if (session.hostId && session.worktreeId && session.ackReceivedAt) {
        continue;
      }
      let idle = [...state.worktrees.values()].filter(
        (w) =>
          w.repositoryId === session.repositoryId &&
          w.status === "idle" &&
          w.online &&
          hostGitReady(state, w.hostId) &&
          hostAcceptsNewAssignments(state, w.hostId) &&
          hostEnvironmentReady(state, w.hostId, session.repositoryId) &&
          !state.drainingHosts.has(w.hostId) &&
          !state.disconnectedHosts.has(w.hostId) &&
          session.requiredLabels.every((l) => w.labels.includes(l)),
      );
      if (session.pinnedHostId) {
        if (session.pinExpiresAt && Date.parse(session.pinExpiresAt) < nowMs) {
          const cleared = await state.storage.clearResumePin({
            sessionId: session.id,
            pinnedHostId: session.pinnedHostId,
            pinExpiresAt: session.pinExpiresAt,
          });
          if (!cleared) continue;
          clearResumePin(session);
          idle = allIdle(state, session);
        } else {
          idle = idle.filter((w) => w.hostId === session.pinnedHostId);
          const hasNativeRoute =
            session.pinnedTargetIndex !== undefined &&
            idle.some((candidate) =>
              resolveSessionTargetRouteAt(
                state,
                catalog,
                session,
                candidate,
                nowMs,
                session.pinnedTargetIndex!,
              ),
            );
          if (!hasNativeRoute) {
            const cleared = await state.storage.clearResumePin({
              sessionId: session.id,
              pinnedHostId: session.pinnedHostId,
              pinExpiresAt: session.pinExpiresAt,
            });
            if (!cleared) continue;
            clearResumePin(session);
            idle = allIdle(state, session);
          }
        }
      }
      idle.sort(compareWorktreesForRoundRobin);
      for (let targetIndex = 0; targetIndex <= session.fallbacks.length; targetIndex++) {
        for (const { candidate, route } of eligibleRoutes(
          state,
          catalog,
          session,
          idle,
          nowMs,
          targetIndex,
        )) {
          const connectionId = state.hostConnection.get(candidate.hostId);
          if (!connectionId) {
            continue;
          }
          const attemptId = state.attemptIdFactory();
          const principalId = sessionPrincipalId(session);
          const won = await state.storage.tryAssignSession({
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
            queueShard: session.queueShard,
          });
          if (!won) {
            continue;
          }
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
        if (assigned.at(-1)?.session.id === session.id) break;
      }
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

function persistExpired(
  state: ControlPlaneState,
  session: import("./db/types.ts").SessionRecord,
): void {
  state.sessions.set(session.id, { ...session });
  if (state.storage) void state.storage.putSession({ ...session });
}

/** Select account/worktree tuples globally, so account fairness precedes worktree RR. */
function eligibleRoutes(
  state: ControlPlaneState,
  catalog: ReturnType<typeof buildProviderCatalog>,
  session: import("./db/types.ts").SessionRecord,
  worktrees: WorktreeRecord[],
  nowMs: number,
  targetIndex: number,
) {
  return worktrees
    .flatMap((candidate) => {
      const route = resolveSessionTargetRouteAt(
        state,
        catalog,
        session,
        candidate,
        nowMs,
        targetIndex,
      );
      return route ? [{ candidate, route }] : [];
    })
    .toSorted((left, right) => {
      const leftAssigned = left.route.providerAccountId
        ? (state.providerAccounts.get(left.route.providerAccountId)?.lastAssignedAt ?? "")
        : "";
      const rightAssigned = right.route.providerAccountId
        ? (state.providerAccounts.get(right.route.providerAccountId)?.lastAssignedAt ?? "")
        : "";
      return (
        leftAssigned.localeCompare(rightAssigned) ||
        compareWorktreesForRoundRobin(left.candidate, right.candidate)
      );
    });
}

function allIdle(
  state: ControlPlaneState,
  session: import("./db/types.ts").SessionRecord,
): WorktreeRecord[] {
  return [...state.worktrees.values()].filter(
    (worktree) =>
      worktree.repositoryId === session.repositoryId &&
      worktree.status === "idle" &&
      worktree.online &&
      hostGitReady(state, worktree.hostId) &&
      hostAcceptsNewAssignments(state, worktree.hostId) &&
      hostEnvironmentReady(state, worktree.hostId, session.repositoryId) &&
      !state.drainingHosts.has(worktree.hostId) &&
      !state.disconnectedHosts.has(worktree.hostId) &&
      session.requiredLabels.every((label) => worktree.labels.includes(label)),
  );
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
    const queued = pending.worktreeId
      ? {
          ...session,
          status: "queued" as const,
          worktreeId: null,
          hostId: null,
          errorMessage: reason,
        }
      : queueReconnectSession(session, reason);
    state.sessions.set(sessionId, queued);
    if (!pending.worktreeId) releaseScheduledLeaseLocal(state, session);
    state.pendingAcks.delete(sessionId);
    requeued.push(sessionId);
  }
  return requeued;
}
