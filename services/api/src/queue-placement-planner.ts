/* eslint-disable max-lines -- one evaluator covers prompt, scheduled, and UI availability. */
import type { ProviderCatalog, TargetRef } from "@auto-harness/shared";

import type { SessionRecord, WorktreeRecord } from "./db/types.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";
import { compareWorktreesForRoundRobin } from "./control-plane-ordering.ts";
import {
  hostAcceptsNewAssignments,
  hostEnvironmentReady,
} from "./control-plane-host-environment.ts";
import {
  accountHasLeaseCapacity,
  hostHasAssignmentCapacity,
  hostProviderAccountReady,
} from "./control-plane-provider-account-leases.ts";
import { repositoryAdmissionOpen } from "./control-plane-repository-admission-state.ts";
import { sessionPrincipalId } from "./control-plane-session-owner.ts";
import {
  resolveSessionTargetRouteAt,
  resolveSessionTargetRoutesAt,
  resolveScheduledSessionTargets,
  type ResolvedSessionRoute,
} from "./control-plane-session-target.ts";

type PlacementWaitReason =
  | "queue_expired"
  | "admission_closed"
  | "admission_draining"
  | "missing_principal"
  | "already_assigned"
  | "no_idle_worktree"
  | "no_eligible_host"
  | "no_eligible_route";

type PromptPlacementPlan =
  | { action: "expire" }
  | { action: "skip"; reason: PlacementWaitReason }
  | { action: "clear_pin" }
  | {
      action: "assign";
      candidates: Array<{ worktree: WorktreeRecord; route: ResolvedSessionRoute }>;
    };

type ScheduledPlacementPlan =
  | { action: "expire" }
  | { action: "cancel"; reason: "admission_draining" | "missing_principal" }
  | { action: "skip"; reason: PlacementWaitReason }
  | {
      action: "assign";
      candidates: Array<{
        hostId: string;
        connectionId: string;
        route: ResolvedSessionRoute;
      }>;
    };

type ScheduledEligibleHost = { hostId: string; connectionId: string };

function hostGitReady(state: ControlPlaneState, hostId: string): boolean {
  const connectionId = state.hostConnection.get(hostId);
  return (
    connectionId !== undefined && state.connections.get(connectionId)?.runtime?.gitReady === true
  );
}

/** Same live-capacity gate used by prompt assignment and UI availability. */
function isSchedulableWorktree(
  state: ControlPlaneState,
  worktree: WorktreeRecord,
  repositoryId?: string,
): boolean {
  return (
    (repositoryId === undefined || worktree.repositoryId === repositoryId) &&
    worktree.status === "idle" &&
    worktree.online &&
    hostGitReady(state, worktree.hostId) &&
    hostAcceptsNewAssignments(state, worktree.hostId) &&
    hostHasAssignmentCapacity(state, worktree.hostId) &&
    hostEnvironmentReady(state, worktree.hostId, worktree.repositoryId) &&
    !state.drainingHosts.has(worktree.hostId) &&
    !state.disconnectedHosts.has(worktree.hostId)
  );
}

function eligibleIdleWorktrees(state: ControlPlaneState, session: SessionRecord): WorktreeRecord[] {
  return [...state.worktrees.values()].filter(
    (worktree) =>
      isSchedulableWorktree(state, worktree, session.repositoryId) &&
      session.requiredLabels.every((label) => worktree.labels.includes(label)),
  );
}

/** Select account/worktree tuples globally, so account fairness precedes worktree RR. */
function eligibleRoutes(
  state: ControlPlaneState,
  catalog: ProviderCatalog,
  session: SessionRecord,
  worktrees: WorktreeRecord[],
  nowMs: number,
  targetIndex: number,
): Array<{ candidate: WorktreeRecord; route: ResolvedSessionRoute }> {
  return worktrees
    .flatMap((candidate) =>
      resolveSessionTargetRoutesAt(state, catalog, session, candidate, nowMs, targetIndex).map(
        (route) => ({ candidate, route }),
      ),
    )
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

function queueExpired(session: SessionRecord, nowMs: number): boolean {
  return Date.parse(session.queueExpiresAt) <= nowMs;
}

export function planPromptPlacement(
  state: ControlPlaneState,
  catalog: ProviderCatalog,
  session: SessionRecord,
  nowMs: number,
): PromptPlacementPlan {
  if (queueExpired(session, nowMs)) return { action: "expire" };
  if (!repositoryAdmissionOpen(state.repositories.get(session.repositoryId)?.admissionState)) {
    return { action: "skip", reason: "admission_closed" };
  }
  if (session.hostId && session.worktreeId && session.ackReceivedAt) {
    return { action: "skip", reason: "already_assigned" };
  }
  let idle = eligibleIdleWorktrees(state, session);
  if (session.pinnedHostId) {
    if (session.pinExpiresAt && Date.parse(session.pinExpiresAt) < nowMs) {
      return { action: "clear_pin" };
    }
    idle = idle.filter((worktree) => worktree.hostId === session.pinnedHostId);
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
    if (!hasNativeRoute) return { action: "clear_pin" };
  }
  idle.sort(compareWorktreesForRoundRobin);
  const candidates: Array<{ worktree: WorktreeRecord; route: ResolvedSessionRoute }> = [];
  for (let targetIndex = 0; targetIndex <= session.fallbacks.length; targetIndex++) {
    for (const { candidate, route } of eligibleRoutes(
      state,
      catalog,
      session,
      idle,
      nowMs,
      targetIndex,
    )) {
      if (
        !hostProviderAccountReady(state, candidate.hostId, route.providerAccountId) ||
        !accountHasLeaseCapacity(state, route.providerAccountId)
      ) {
        continue;
      }
      candidates.push({ worktree: candidate, route });
    }
  }
  if (candidates.length === 0) {
    return {
      action: "skip",
      reason: idle.length === 0 ? "no_idle_worktree" : "no_eligible_route",
    };
  }
  return { action: "assign", candidates };
}

export function planScheduledPlacement(
  state: ControlPlaneState,
  catalog: ProviderCatalog,
  session: SessionRecord,
  hosts: readonly ScheduledEligibleHost[],
): ScheduledPlacementPlan {
  const nowMs = Date.parse(state.now());
  if (queueExpired(session, nowMs)) return { action: "expire" };
  const admissionState = state.repositories.get(session.repositoryId)?.admissionState;
  if (admissionState === "draining") return { action: "cancel", reason: "admission_draining" };
  if (!repositoryAdmissionOpen(admissionState)) {
    return { action: "skip", reason: "admission_closed" };
  }
  if (!sessionPrincipalId(session)) return { action: "cancel", reason: "missing_principal" };
  const candidates: Array<{
    hostId: string;
    connectionId: string;
    route: ResolvedSessionRoute;
  }> = [];
  for (const host of hosts) {
    for (const route of resolveScheduledSessionTargets(state, catalog, session, host.hostId)) {
      if (
        hostProviderAccountReady(state, host.hostId, route.providerAccountId) &&
        accountHasLeaseCapacity(state, route.providerAccountId)
      ) {
        candidates.push({ ...host, route });
      }
    }
  }
  if (candidates.length === 0) {
    return {
      action: "skip",
      reason: hosts.length === 0 ? "no_eligible_host" : "no_eligible_route",
    };
  }
  return { action: "assign", candidates };
}

function sessionWithClearedPin(session: SessionRecord): SessionRecord {
  const cleared = { ...session, resumeFallback: true };
  delete cleared.pinnedHostId;
  delete cleared.pinnedProviderAccountId;
  delete cleared.pinnedTargetIndex;
  delete cleared.pinnedCommandId;
  delete cleared.pinExpiresAt;
  return cleared;
}

export function explainPromptPlacement(
  state: ControlPlaneState,
  catalog: ProviderCatalog,
  session: SessionRecord,
  nowMs: number,
): PlacementWaitReason | "assignable" {
  const plan = planPromptPlacement(state, catalog, session, nowMs);
  if (plan.action === "clear_pin") {
    return explainPromptPlacement(state, catalog, sessionWithClearedPin(session), nowMs);
  }
  if (plan.action === "assign") return "assignable";
  if (plan.action === "expire") return "queue_expired";
  return plan.reason;
}

export function targetIsAvailable(
  state: ControlPlaneState,
  catalog: ProviderCatalog,
  target: TargetRef,
  nowMs: number,
): boolean {
  return [...state.worktrees.values()].some((worktree) => {
    if (!isSchedulableWorktree(state, worktree)) return false;
    const route = resolveSessionTargetRouteAt(
      state,
      catalog,
      {
        id: "availability-probe",
        repositoryId: worktree.repositoryId,
        prompt: "",
        target,
        fallbacks: [],
        targetLabels: [],
        queueTtlSeconds: 1,
        queueExpiresAt: "9999-01-01T00:00:00.000Z",
        timeout: 1,
        priority: 0,
        requiredLabels: [],
        status: "queued",
        queueShard: 0,
        createdAt: "1970-01-01T00:00:00.000Z",
      },
      worktree,
      nowMs,
      0,
    );
    return (
      Boolean(route) &&
      hostProviderAccountReady(state, worktree.hostId, route?.providerAccountId) &&
      accountHasLeaseCapacity(state, route?.providerAccountId)
    );
  });
}
