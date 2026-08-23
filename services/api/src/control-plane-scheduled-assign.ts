import {
  hasHostCapability,
  repositoryAdmissionState,
  type HostWireMessage,
} from "@auto-harness/shared";

import type { PublicSession } from "./control-plane-types.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";
import { toPublic } from "./control-plane-state.ts";
import {
  buildProviderCatalog,
  resolveScheduledSessionTarget,
} from "./control-plane-session-target.ts";
import { compareSessionsForQueue } from "./control-plane-ordering.ts";
import {
  listQueuedSessionsDurable,
  refreshSchedulerReadModel,
} from "./control-plane-durable-read-runtime.ts";
import { hostEnvironmentReady } from "./control-plane-host-environment.ts";
import { cancelSessionDurable } from "./control-plane-cancel-durable.ts";

export { releaseScheduledLeaseLocal } from "./control-plane-scheduled-lease.ts";

const leaseKey = (hostId: string, repositoryId: string) => `${hostId}\0${repositoryId}`;

type ScheduledAssignment = { session: PublicSession; hostId: string; worktreeId: null };
async function eligibleHosts(state: ControlPlaneState, repositoryId: string) {
  const unique = new Map<string, string>();
  for (const connection of state.connections.values()) {
    if (
      connection.type === "host" &&
      state.hostConnection.get(connection.hostId) === connection.connectionId &&
      hasHostCapability(connection.capabilities, "scheduled-main-checkout") &&
      connection.runtime?.gitReady === true &&
      hostEnvironmentReady(state, connection.hostId, repositoryId) &&
      connection.repositoryIds?.includes(repositoryId)
    )
      unique.set(connection.hostId, connection.connectionId);
  }
  const hosts = [...unique.entries()]
    .filter(([hostId]) => !state.drainingHosts.has(hostId) && !state.disconnectedHosts.has(hostId))
    .filter(
      ([hostId]) =>
        state.storage !== undefined ||
        !state.mainCheckoutLeases.has(leaseKey(hostId, repositoryId)),
    );
  const cursors = new Map<string, string>();
  for (const [hostId] of hosts) {
    const cursor = state.storage
      ? await state.storage.getMainCheckoutCursor(hostId)
      : (() => {
          const last = (id: string) =>
            [...state.sessions.values()]
              .filter((session) => session.type === "scheduled" && session.hostId === id)
              .map((session) => session.startedAt ?? "")
              .toSorted()
              .at(-1) ?? "";
          return last(hostId);
        })();
    cursors.set(hostId, cursor ?? "");
  }
  return hosts
    .toSorted(([a], [b]) => cursors.get(a)!.localeCompare(cursors.get(b)!) || a.localeCompare(b))
    .map(([hostId, connectionId]) => ({ hostId, connectionId }));
}

function wire(session: import("./db/types.ts").SessionRecord, now: string): HostWireMessage {
  return {
    type: "session:assign",
    sessionId: session.id,
    sessionType: "scheduled",
    repositoryId: session.repositoryId,
    prompt: session.prompt,
    resolvedArgv: session.resolvedArgv!,
    timeout: session.timeout,
    worktreeId: null,
    assignedAt: now,
    attemptId: session.attemptId!,
    ...(session.ref ? { ref: session.ref } : {}),
    ...(session.metadata ? { metadata: session.metadata } : {}),
  };
}

export async function assignScheduledQueuedDurable(
  state: ControlPlaneState,
): Promise<ScheduledAssignment[]> {
  if (state.storage) {
    await refreshSchedulerReadModel(state);
    await listQueuedSessionsDurable(state, "scheduled");
  }
  const assigned: ScheduledAssignment[] = [];
  const now = state.now();
  const catalog = buildProviderCatalog(state);
  for (let shard = 0; shard < state.shardCount; shard++) {
    const queued = [...state.sessions.values()]
      .filter(
        (session) =>
          session.type === "scheduled" &&
          session.status === "queued" &&
          session.queueShard === shard,
      )
      .filter((session) => !session.retryAfter || Date.parse(session.retryAfter) <= Date.parse(now))
      .toSorted(compareSessionsForQueue);
    for (const session of queued) {
      if (
        repositoryAdmissionState(state.repositories.get(session.repositoryId)?.admissionState) !==
        "active"
      ) {
        await cancelSessionDurable(state, session.id);
        continue;
      }
      for (const { hostId, connectionId } of await eligibleHosts(state, session.repositoryId)) {
        const connection = state.connections.get(connectionId);
        if (state.hostConnection.get(hostId) !== connectionId || !connection?.runtime?.gitReady)
          continue;
        const target = resolveScheduledSessionTarget(state, catalog, session, hostId);
        if (!target) continue;
        const attemptId = state.attemptIdFactory();
        const won = state.storage
          ? (await state.storage.ensureMainCheckoutLeaseMap(hostId, connectionId)) &&
            (await state.storage.tryAssignMainCheckoutSession({
              sessionId: session.id,
              hostId,
              hostInventoryVersion: state.hostInventories.has(hostId)
                ? (state.hostInventories.get(hostId)!.version ?? 0)
                : null,
              repositoryId: session.repositoryId,
              connectionId,
              now,
              resolvedArgv: target.resolvedArgv,
              resumeSpec: target.resumeSpec,
              resolvedRoute: {
                targetIndex: target.targetIndex,
                commandId: target.commandId,
                ...(target.providerAccountId
                  ? { providerAccountId: target.providerAccountId }
                  : {}),
                hostId,
                worktreeId: null,
                attemptId,
              },
              ...(target.providerAccountId ? { providerAccountId: target.providerAccountId } : {}),
              queueShard: session.queueShard,
              attemptId,
            }))
          : !state.mainCheckoutLeases.has(leaseKey(hostId, session.repositoryId));
        if (!won) continue;
        const next = {
          ...session,
          status: "running" as const,
          worktreeId: null,
          hostId,
          startedAt: now,
          assignmentSentAt: now,
          resolvedArgv: target.resolvedArgv,
          ...(session.resumeSpec === undefined && target.resumeSpec !== undefined
            ? { resumeSpec: target.resumeSpec }
            : {}),
          resolvedRoute: {
            targetIndex: target.targetIndex,
            commandId: target.commandId,
            ...(target.providerAccountId ? { providerAccountId: target.providerAccountId } : {}),
            hostId,
            worktreeId: null,
            attemptId,
          },
          assignmentConnectionId: connectionId,
          mainCheckoutLease: true,
          attemptId,
        };
        delete next.completedAt;
        delete next.exitCode;
        delete next.errorCode;
        delete next.errorMessage;
        delete next.retryAfter;
        state.sessions.set(session.id, next);
        if (target.providerAccountId) {
          const account = state.providerAccounts.get(target.providerAccountId);
          if (account) {
            state.providerAccounts.set(account.id, {
              ...account,
              lastAssignedAt: now,
              updatedAt: now,
            });
          }
        }
        state.mainCheckoutLeases.set(leaseKey(hostId, session.repositoryId), {
          sessionId: session.id,
          connectionId,
        });
        state.pendingAcks.set(session.id, {
          sessionId: session.id,
          worktreeId: null,
          attemptId,
          assignedAtMs: Date.parse(now),
        });
        state.onHostMessage?.(hostId, wire(next, now));
        assigned.push({ session: toPublic(state, next), hostId, worktreeId: null });
        break;
      }
    }
  }
  return assigned;
}
