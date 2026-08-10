/* eslint-disable max-lines */
import type { HostWireMessage } from "@auto-harness/shared";

import type { SessionRecord, WorktreeRecord } from "./db/types.ts";
import type { PublicSession } from "./control-plane-types.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";
import { toPublic } from "./control-plane-state.ts";
import { compareSessionsForQueue, compareWorktreesForRoundRobin } from "./services/scheduler.ts";
import { releaseWorktree, tryClaimWorktree } from "./control-plane-worktrees.ts";
import { buildProviderCatalog, resolveSessionTarget } from "./control-plane-session-target.ts";
import { materializeResumeArgv } from "@auto-harness/shared";

function assignmentArgv(
  session: SessionRecord,
  target: ReturnType<typeof resolveSessionTarget>,
): { argv: string[]; resumeSpec: NonNullable<SessionRecord["resumeSpec"]> } | null {
  const resumeSpec = session.resumeSpec ?? target?.resumeSpec;
  if (!resumeSpec) return null;
  if (session.resumedFromSessionId && resumeSpec.resumeArgvTemplate) {
    if (!session.cliResumeRef) return null;
    return {
      argv: materializeResumeArgv(
        resumeSpec.resumeArgvTemplate,
        session.cliResumeRef,
        session.prompt,
      ),
      resumeSpec,
    };
  }
  if (session.resumedFromSessionId) {
    return {
      argv: resumeSpec.appendPrompt ? [...resumeSpec.argv, session.prompt] : [...resumeSpec.argv],
      resumeSpec,
    };
  }
  return target ? { argv: target.resolvedArgv, resumeSpec } : null;
}

function resumeRefCaptureForWire(session: SessionRecord) {
  return session.resumeSpec?.resumeRefCapture;
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
      .filter((s) => s.status === "queued" && s.queueShard === shard)
      .filter((s) => {
        if (s.retryAfter && Date.parse(s.retryAfter) > nowMs) {
          return false;
        }
        return true;
      })
      .toSorted(compareSessionsForQueue);

    for (const session of queued) {
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
          !state.drainingHosts.has(w.hostId) &&
          !state.disconnectedHosts.has(w.hostId) &&
          session.requiredLabels.every((l) => w.labels.includes(l)),
      );
      if (session.pinnedHostId) {
        if (session.pinExpiresAt && Date.parse(session.pinExpiresAt) < nowMs) {
          session.errorCode = "resume_failed";
          session.errorMessage = "pin expired";
          session.status = "failed";
          continue;
        }
        idle = idle.filter((w) => w.hostId === session.pinnedHostId);
      }
      idle.sort(compareWorktreesForRoundRobin);

      for (const candidate of idle) {
        const target = resolveSessionTarget(state, catalog, session, candidate);
        const assignment = assignmentArgv(session, target);
        if (!assignment) {
          continue;
        }
        const resolvedArgv = assignment.argv;
        const won = tryClaimWorktree(state, candidate.id, session.id, nowIso);
        if (!won) {
          continue;
        }
        session.status = "running";
        session.worktreeId = candidate.id;
        session.hostId = candidate.hostId;
        session.startedAt = nowIso;
        session.resolvedArgv = resolvedArgv;
        session.resumeSpec ??= assignment.resumeSpec;
        delete session.ackReceivedAt;
        state.pendingAcks.set(session.id, {
          sessionId: session.id,
          worktreeId: candidate.id,
          assignedAtMs: nowMs,
        });

        const resumeRefCapture = resumeRefCaptureForWire(session);
        const msg: HostWireMessage = {
          type: "session:assign",
          sessionId: session.id,
          repositoryId: session.repositoryId,
          prompt: session.prompt,
          resolvedArgv,
          timeout: session.timeout,
          worktreeId: candidate.id,
          assignedAt: nowIso,
          ...(session.ref !== undefined ? { ref: session.ref } : {}),
          ...(session.metadata !== undefined ? { metadata: session.metadata } : {}),
          ...(resumeRefCapture !== undefined ? { resumeRefCapture } : {}),
          ...(session.resumedFromSessionId
            ? {
                resume: true,
                resumedFromSessionId: session.resumedFromSessionId,
                ...(session.cliResumeRef !== undefined
                  ? { cliResumeRef: session.cliResumeRef }
                  : {}),
              }
            : {}),
        };
        state.onHostMessage?.(candidate.hostId, msg);
        assigned.push({ session: toPublic(state, session), worktree: { ...candidate } });
        break;
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
  const assigned: Array<{ session: PublicSession; worktree: WorktreeRecord }> = [];
  const nowIso = state.now();
  const nowMs = Date.parse(nowIso);
  const catalog = buildProviderCatalog(state);

  for (let shard = 0; shard < state.shardCount; shard++) {
    const queued = [...state.sessions.values()]
      .filter((s) => s.status === "queued" && s.queueShard === shard)
      .filter((s) => !s.retryAfter || Date.parse(s.retryAfter) <= nowMs)
      .toSorted(compareSessionsForQueue);
    for (const session of queued) {
      if (session.hostId && session.worktreeId && session.ackReceivedAt) {
        continue;
      }
      let idle = [...state.worktrees.values()].filter(
        (w) =>
          w.repositoryId === session.repositoryId &&
          w.status === "idle" &&
          w.online &&
          !state.drainingHosts.has(w.hostId) &&
          !state.disconnectedHosts.has(w.hostId) &&
          session.requiredLabels.every((l) => w.labels.includes(l)),
      );
      if (session.pinnedHostId) {
        if (session.pinExpiresAt && Date.parse(session.pinExpiresAt) < nowMs) {
          const failed = await state.storage.failExpiredResumeSession({
            sessionId: session.id,
            queueShard: session.queueShard,
            pinExpiresAt: session.pinExpiresAt,
          });
          if (failed) {
            state.sessions.set(session.id, {
              ...session,
              status: "failed",
              errorCode: "resume_failed",
              errorMessage: "pin expired",
            });
          }
          continue;
        }
        idle = idle.filter((w) => w.hostId === session.pinnedHostId);
      }
      idle.sort(compareWorktreesForRoundRobin);
      for (const candidate of idle) {
        const connectionId = state.hostConnection.get(candidate.hostId);
        if (!connectionId) {
          continue;
        }
        const target = resolveSessionTarget(state, catalog, session, candidate);
        const assignment = assignmentArgv(session, target);
        if (!assignment) {
          continue;
        }
        const resolvedArgv = assignment.argv;
        const won = await state.storage.tryAssignSession({
          sessionId: session.id,
          worktreeId: candidate.id,
          hostId: candidate.hostId,
          connectionId,
          now: nowIso,
          resolvedArgv,
          resumeSpec: session.resumeSpec ?? assignment.resumeSpec,
          queueShard: session.queueShard,
        });
        if (!won) {
          continue;
        }
        const nextSession = {
          ...session,
          status: "running" as const,
          worktreeId: candidate.id,
          hostId: candidate.hostId,
          startedAt: nowIso,
          resolvedArgv,
          resumeSpec: session.resumeSpec ?? assignment.resumeSpec,
          assignmentConnectionId: connectionId,
        };
        const nextWorktree = {
          ...candidate,
          status: "busy" as const,
          currentSessionId: session.id,
          lastAssignedAt: nowIso,
          connectionId,
        };
        state.sessions.set(session.id, nextSession);
        state.worktrees.set(candidate.id, nextWorktree);
        state.pendingAcks.set(session.id, {
          sessionId: session.id,
          worktreeId: candidate.id,
          assignedAtMs: nowMs,
        });
        const msg: HostWireMessage = {
          type: "session:assign",
          sessionId: session.id,
          repositoryId: session.repositoryId,
          prompt: session.prompt,
          resolvedArgv,
          timeout: session.timeout,
          worktreeId: candidate.id,
          assignedAt: nowIso,
          ...(session.ref !== undefined ? { ref: session.ref } : {}),
          ...(session.metadata !== undefined ? { metadata: session.metadata } : {}),
          ...(nextSession.resumeSpec?.resumeRefCapture !== undefined
            ? { resumeRefCapture: nextSession.resumeSpec.resumeRefCapture }
            : {}),
          ...(session.resumedFromSessionId
            ? {
                resume: true,
                resumedFromSessionId: session.resumedFromSessionId,
                ...(session.cliResumeRef !== undefined
                  ? { cliResumeRef: session.cliResumeRef }
                  : {}),
              }
            : {}),
        };
        state.onHostMessage?.(candidate.hostId, msg);
        assigned.push({ session: toPublic(state, nextSession), worktree: { ...nextWorktree } });
        break;
      }
    }
  }
  return assigned;
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
    if (!session || session.ackReceivedAt) {
      state.pendingAcks.delete(sessionId);
      continue;
    }
    releaseWorktree(state, pending.worktreeId);
    session.status = "queued";
    session.worktreeId = null;
    session.hostId = null;
    delete session.startedAt;
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
  const requeued: string[] = [];
  for (const [sessionId, pending] of state.pendingAcks) {
    if (nowMs - pending.assignedAtMs < state.ackDeadlineMs) {
      continue;
    }
    const session = state.sessions.get(sessionId);
    if (!session || session.ackReceivedAt) {
      state.pendingAcks.delete(sessionId);
      continue;
    }
    const won = await state.storage.tryRequeueSession({
      sessionId,
      worktreeId: pending.worktreeId,
      queueShard: session.queueShard,
      reason: "agent did not acknowledge assignment; requeued",
    });
    if (!won) {
      state.pendingAcks.delete(sessionId);
      continue;
    }
    const wt = state.worktrees.get(pending.worktreeId);
    if (wt) {
      state.worktrees.set(pending.worktreeId, {
        ...wt,
        status: "idle",
        currentSessionId: null,
      });
    }
    state.sessions.set(sessionId, {
      ...session,
      status: "queued",
      worktreeId: null,
      hostId: null,
      errorMessage: "agent did not acknowledge assignment; requeued",
    });
    state.pendingAcks.delete(sessionId);
    requeued.push(sessionId);
  }
  return requeued;
}
