import type { HostWireMessage } from "@auto-harness/shared";

import type { WorktreeRecord } from "./db/types.ts";
import type { PublicSession } from "./control-plane-types.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";
import { toPublic } from "./control-plane-state.ts";
import { compareSessionsForQueue, compareWorktreesForRoundRobin } from "./services/scheduler.ts";
import { releaseWorktree, tryClaimWorktree } from "./control-plane-worktrees.ts";
import { buildProviderCatalog, resolveSessionTargetArgv } from "./control-plane-session-target.ts";

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
      if (session.agentId && session.worktreeId && session.ackReceivedAt) {
        continue;
      }
      // Resume pin: only assign to pinned agent when set (Invariant 7).
      // Skip draining / disconnected agents (online must stay false for zombies).
      let idle = [...state.worktrees.values()].filter(
        (w) =>
          w.repositoryId === session.repositoryId &&
          w.status === "idle" &&
          w.online &&
          !state.drainingAgents.has(w.agentId) &&
          !state.disconnectedAgents.has(w.agentId) &&
          session.requiredLabels.every((l) => w.labels.includes(l)),
      );
      if (session.pinnedAgentId) {
        if (session.pinExpiresAt && Date.parse(session.pinExpiresAt) < nowMs) {
          session.errorCode = "resume_failed";
          session.errorMessage = "pin expired";
          session.status = "failed";
          continue;
        }
        idle = idle.filter((w) => w.agentId === session.pinnedAgentId);
      }
      idle.sort(compareWorktreesForRoundRobin);

      for (const candidate of idle) {
        const resolvedArgv = resolveSessionTargetArgv(state, catalog, session, candidate);
        if (!resolvedArgv) {
          continue;
        }
        const won = tryClaimWorktree(state, candidate.id, session.id, nowIso);
        if (!won) {
          continue;
        }
        session.status = "running";
        session.worktreeId = candidate.id;
        session.agentId = candidate.agentId;
        session.startedAt = nowIso;
        session.resolvedArgv = resolvedArgv;
        delete session.ackReceivedAt;
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
        state.onAgentMessage?.(candidate.agentId, msg);
        assigned.push({ session: toPublic(state, session), worktree: { ...candidate } });
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
    session.agentId = null;
    delete session.startedAt;
    state.pendingAcks.delete(sessionId);
    requeued.push(sessionId);
  }
  return requeued;
}
