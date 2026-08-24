/* eslint-disable max-lines */
import { hasHostCapability, type HostWireMessage } from "@auto-harness/shared";

import type { PublicSession } from "./control-plane-types.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";
import { toPublic } from "./control-plane-state.ts";
import { buildProviderCatalog } from "./control-plane-session-target.ts";
import { orderedQueuedSessions } from "./control-plane-ordering.ts";
import {
  listQueuedSessionsDurable,
  refreshSchedulerReadModel,
} from "./control-plane-durable-read-runtime.ts";
import { hostEnvironmentReady } from "./control-plane-host-environment.ts";
import { cancelSessionDurable } from "./control-plane-cancel-durable.ts";
import { sessionPrincipalId } from "./control-plane-session-owner.ts";
import { planScheduledPlacement } from "./queue-placement-planner.ts";

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
    if (typeof state.storage.backfillQueuedSessionQueueOrder === "function") {
      await state.storage.backfillQueuedSessionQueueOrder(state.shardCount);
    }
    await refreshSchedulerReadModel(state);
    await listQueuedSessionsDurable(state, "scheduled");
  }
  const assigned: ScheduledAssignment[] = [];
  const now = state.now();
  const catalog = buildProviderCatalog(state);
  for (const session of orderedQueuedSessions(
    state.sessions.values(),
    state.shardCount,
    "scheduled",
  )) {
    const hosts = await eligibleHosts(state, session.repositoryId);
    const plan = planScheduledPlacement(state, catalog, session, hosts);
    if (plan.action === "expire") {
      await expireScheduledQueued(state, session, now);
      continue;
    }
    if (plan.action === "cancel") {
      await cancelSessionDurable(state, session.id);
      continue;
    }
    if (plan.action !== "assign") continue;
    const principalId = sessionPrincipalId(session);
    if (!principalId) {
      await cancelSessionDurable(state, session.id);
      continue;
    }
    let placed:
      | {
          hostId: string;
          connectionId: string;
          target: (typeof plan.candidates)[number]["route"];
          attemptId: string;
        }
      | undefined;
    for (const { hostId, connectionId, route: target } of plan.candidates) {
      const connection = state.connections.get(connectionId);
      if (state.hostConnection.get(hostId) !== connectionId || !connection?.runtime?.gitReady)
        continue;
      const attemptId = state.attemptIdFactory();
      const won = state.storage
        ? (await state.storage.ensureMainCheckoutLeaseMap(hostId, connectionId)) &&
          (await state.storage.tryAssignMainCheckoutSession({
            sessionId: session.id,
            hostId,
            principalId,
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
              ...(target.providerAccountId ? { providerAccountId: target.providerAccountId } : {}),
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
      placed = { hostId, connectionId, target, attemptId };
      break;
    }
    if (!placed) continue;
    const { hostId, connectionId, target, attemptId } = placed;
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
  }
  return assigned;
}

async function expireScheduledQueued(
  state: ControlPlaneState,
  session: import("./db/types.ts").SessionRecord,
  now: string,
): Promise<void> {
  const next = {
    ...session,
    status: "failed" as const,
    completedAt: now,
    errorCode: "queue_expired",
    errorMessage: "queue TTL expired before capacity became available",
  };
  if (state.storage) {
    const expired = await state.storage.expireQueuedSession({
      sessionId: session.id,
      queueShard: session.queueShard,
      queueExpiresAt: session.queueExpiresAt,
      completedAt: now,
      ...(session.concurrencyId ? { concurrencyId: session.concurrencyId } : {}),
    });
    if (expired) state.sessions.set(session.id, next);
    return;
  }
  state.sessions.set(session.id, next);
}
