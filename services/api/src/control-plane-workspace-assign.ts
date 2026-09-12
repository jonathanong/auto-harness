/* eslint-disable max-lines -- workspace placement keeps lease acquisition and dispatch together. */
import type { HostWireMessage } from "@auto-harness/shared";

import type { PublicSession } from "./control-plane-types.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";
import { toPublic } from "./control-plane-state.ts";
import type { SessionRecord, WorkspaceSlotRecord } from "./db/types.ts";
import { buildProviderCatalog } from "./control-plane-session-target.ts";
import { orderedQueuedSessions } from "./control-plane-ordering.ts";
import { planWorkspacePlacement } from "./queue-placement-planner.ts";
import {
  accountHasLeaseCapacity,
  hostAssignmentOccupancyCount,
  hostProviderAccountReady,
  tryAcquireProviderAccountLeaseLocal,
} from "./control-plane-provider-account-leases.ts";
import {
  listQueuedSessionsDurable,
  listWorkspaceSlotsDurable,
  refreshSchedulerReadModel,
} from "./control-plane-durable-read-runtime.ts";
import type { AssignmentWriteResult } from "./db/plane-storage-types.ts";

export type WorkspaceAssignment = {
  session: PublicSession;
  workspaceSlot: WorkspaceSlotRecord;
};

/** Leave framing headroom below the control-channel's 128 KiB WebSocket limit. */
const MAX_WORKSPACE_ASSIGN_BYTES = 120 * 1024;

function setupScriptFor(state: ControlPlaneState, session: SessionRecord): string | undefined {
  const pool = session.workspacePoolId
    ? state.workspacePools.get(session.workspacePoolId)
    : undefined;
  const profileId = session.setupProfileId ?? pool?.defaultSetupProfileId;
  return profileId
    ? pool?.setupProfiles.find((profile) => profile.id === profileId)?.script
    : undefined;
}

function assignMessage(
  session: SessionRecord,
  slot: WorkspaceSlotRecord,
  route: import("./control-plane-session-target.ts").ResolvedSessionRoute,
  attemptId: string,
  assignedAt: string,
  setupScript: string | undefined,
): HostWireMessage {
  return {
    type: "session:assign",
    sessionId: session.id,
    sessionType: "workspace",
    repositoryId: null,
    worktreeId: null,
    workspacePoolId: session.workspacePoolId!,
    workspaceSlotId: slot.id,
    ...(session.setupProfileId ? { setupProfileId: session.setupProfileId } : {}),
    ...(setupScript ? { setupScript } : {}),
    ...(session.destroyWorkspaceAfter !== undefined
      ? { destroyWorkspaceAfter: session.destroyWorkspaceAfter }
      : {}),
    // Workspace execution only consumes resolvedArgv. Keeping the prompt out
    // of this field avoids serializing an untrusted prompt twice; a command
    // that opts out of appendPrompt does not consume it at all.
    prompt: "",
    resolvedArgv: route.resolvedArgv,
    timeout: session.timeout,
    assignedAt,
    attemptId,
    ...(session.metadata ? { metadata: session.metadata } : {}),
    ...(route.providerAccountId ? { providerAccountId: route.providerAccountId } : {}),
    commandId: route.commandId,
    targetIndex: route.targetIndex,
  };
}

/** JSON escaping can grow hostile input several-fold, so measure the real frame. */
function fitsWorkspaceAssignFrame(message: HostWireMessage): boolean {
  return Buffer.byteLength(JSON.stringify(message), "utf8") <= MAX_WORKSPACE_ASSIGN_BYTES;
}

function nextSession(
  session: SessionRecord,
  slot: WorkspaceSlotRecord,
  route: import("./control-plane-session-target.ts").ResolvedSessionRoute,
  attemptId: string,
  now: string,
  lease: SessionRecord["providerAccountLease"],
): SessionRecord {
  return {
    ...session,
    status: "running",
    repositoryId: "",
    worktreeId: null,
    workspaceSlotId: slot.id,
    workspaceSlotLease: true,
    hostId: slot.hostId,
    startedAt: now,
    attemptId,
    resolvedArgv: route.resolvedArgv,
    resolvedRoute: {
      targetIndex: route.targetIndex,
      ...(route.providerId ? { providerId: route.providerId } : {}),
      ...(route.providerAccountId ? { providerAccountId: route.providerAccountId } : {}),
      commandId: route.commandId,
      hostId: slot.hostId,
      worktreeId: null,
      workspacePoolId: session.workspacePoolId!,
      workspaceSlotId: slot.id,
      attemptId,
    },
    ...(lease ? { providerAccountLease: lease } : {}),
    hostAssignmentLease: { hostId: slot.hostId },
  };
}

function touchAccount(state: ControlPlaneState, id: string | undefined, at: string): void {
  if (!id) return;
  const account = state.providerAccounts.get(id);
  if (account) state.providerAccounts.set(id, { ...account, lastAssignedAt: at, updatedAt: at });
}

async function expireWorkspaceSession(
  state: ControlPlaneState,
  session: SessionRecord,
  now: string,
) {
  if (state.storage) {
    const expired = await state.storage.expireQueuedSession({
      sessionId: session.id,
      queueShard: session.queueShard,
      queueExpiresAt: session.queueExpiresAt,
      completedAt: now,
      ...(session.concurrencyId ? { concurrencyId: session.concurrencyId } : {}),
    });
    if (!expired) return;
  }
  state.sessions.set(session.id, {
    ...session,
    status: "failed",
    completedAt: now,
    errorCode: "queue_expired",
    errorMessage: "queue TTL expired before workspace capacity became available",
  });
}

export async function assignWorkspaceQueuedDurable(
  state: ControlPlaneState,
  sessionId?: string,
  options?: { readModelLoaded?: boolean },
): Promise<WorkspaceAssignment[]> {
  if (state.storage && !options?.readModelLoaded) {
    await refreshSchedulerReadModel(state);
    await listQueuedSessionsDurable(state, "workspace");
  }
  const assigned: WorkspaceAssignment[] = [];
  const now = state.now();
  const nowMs = Date.parse(now);
  const catalog = buildProviderCatalog(state);
  for (const session of orderedQueuedSessions(
    state.sessions.values(),
    state.shardCount,
    "workspace",
  )) {
    if (sessionId && session.id !== sessionId) continue;
    if (state.storage && session.workspacePoolId) {
      await listWorkspaceSlotsDurable(state, session.workspacePoolId);
    }
    const plan = planWorkspacePlacement(state, catalog, session, nowMs);
    if (plan.action === "expire") {
      await expireWorkspaceSession(state, session, now);
      continue;
    }
    if (plan.action !== "assign") continue;
    for (const { slot, route } of plan.candidates) {
      const connectionId = state.hostConnection.get(slot.hostId);
      if (!connectionId) continue;
      if (
        !hostProviderAccountReady(state, slot.hostId, route.providerAccountId) ||
        !accountHasLeaseCapacity(state, route.providerAccountId)
      )
        continue;
      const attemptId = state.attemptIdFactory();
      const message = assignMessage(
        session,
        slot,
        route,
        attemptId,
        now,
        session.workspaceSetupScript ?? setupScriptFor(state, session),
      );
      // Never commit a lease whose control frame the daemon cannot receive.
      // The session remains queued for an operator to reduce its opted-in
      // trusted setup profile or prompt/configuration payload.
      if (!fitsWorkspaceAssignFrame(message)) continue;
      const occupied = new Set<number>();
      let lease: ReturnType<typeof tryAcquireProviderAccountLeaseLocal>;
      let won: AssignmentWriteResult = false;
      while (true) {
        lease = tryAcquireProviderAccountLeaseLocal(
          state,
          session,
          route.providerAccountId,
          attemptId,
          slot.hostId,
          occupied,
          Boolean(!state.storage),
        );
        if (route.providerAccountId && !lease) break;
        if (state.storage) {
          won = await state.storage.tryAssignWorkspaceSession({
            sessionId: session.id,
            workspacePoolId: session.workspacePoolId!,
            workspaceSlotId: slot.id,
            hostId: slot.hostId,
            connectionId,
            now,
            attemptId,
            resolvedArgv: route.resolvedArgv,
            resolvedRoute: {
              targetIndex: route.targetIndex,
              ...(route.providerId ? { providerId: route.providerId } : {}),
              ...(route.providerAccountId ? { providerAccountId: route.providerAccountId } : {}),
              commandId: route.commandId,
              hostId: slot.hostId,
              worktreeId: null,
              workspacePoolId: session.workspacePoolId!,
              workspaceSlotId: slot.id,
              attemptId,
            },
            ...(route.providerAccountId ? { providerAccountId: route.providerAccountId } : {}),
            ...(route.providerId ? { providerId: route.providerId } : {}),
            ...(lease ? { providerAccountLease: lease } : {}),
            hostAssignmentLease: { hostId: slot.hostId },
            legacyAssignmentCount: hostAssignmentOccupancyCount(state, slot.hostId),
            ...(state.connections.get(connectionId)?.maxConcurrentAssignments !== undefined
              ? { hostAssignmentCap: state.connections.get(connectionId)!.maxConcurrentAssignments }
              : {}),
            queueShard: session.queueShard,
          });
        } else {
          won = slot.status === "idle" && slot.online;
        }
        if (won === true || !lease) break;
        state.providerAccountLeases.delete(lease.concurrencyId);
        if (won !== "lease_collision") break;
        occupied.add(lease.slot);
      }
      if (won !== true) continue;
      const updatedSession = nextSession(session, slot, route, attemptId, now, lease);
      const updatedSlot: WorkspaceSlotRecord = {
        ...slot,
        status: "busy",
        currentSessionId: session.id,
        connectionId,
        lastAssignedAt: now,
      };
      state.sessions.set(session.id, updatedSession);
      state.workspaceSlots.set(slot.id, updatedSlot);
      touchAccount(state, route.providerAccountId, now);
      state.pendingAcks.set(session.id, {
        sessionId: session.id,
        worktreeId: null,
        attemptId,
        assignedAtMs: nowMs,
      });
      state.onHostMessage?.(slot.hostId, message);
      assigned.push({ session: toPublic(state, updatedSession), workspaceSlot: updatedSlot });
      break;
    }
  }
  return assigned;
}
