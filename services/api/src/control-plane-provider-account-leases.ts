/* eslint-disable max-lines -- provider-account capacity and lease lifecycle share one state helper. */
import {
  DEFAULT_MAX_CONCURRENT_SESSIONS,
  providerAccountLeaseConcurrencyId,
} from "@auto-harness/shared";

import type { SessionRecord } from "./db/types.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";
import { queueWrite } from "./control-plane-state.ts";

type ProviderAccountLease = {
  concurrencyId: string;
  providerAccountId: string;
  slot: number;
  attemptId: string;
};

export function maxConcurrentSessionsFor(
  account: { maxConcurrentSessions?: number } | undefined,
): number {
  return account?.maxConcurrentSessions ?? DEFAULT_MAX_CONCURRENT_SESSIONS;
}

export function hostProviderAccountReady(
  state: ControlPlaneState,
  hostId: string,
  providerAccountId: string | undefined,
): boolean {
  if (!providerAccountId) return true;
  const connectionId = state.hostConnection.get(hostId);
  const readiness = connectionId
    ? state.connections.get(connectionId)?.providerAccountReadiness
    : undefined;
  // Missing advertisements fail closed: the exact local profile is unavailable.
  return (
    readiness?.some((entry) => entry.providerAccountId === providerAccountId && entry.ready) ===
    true
  );
}

/** True when the daemon still holds this session against advertised host capacity. */
export function sessionOccupiesHostAssignment(session: SessionRecord): boolean {
  if (!session.hostId) return false;
  return (
    session.status === "running" ||
    session.providerAccountLease !== undefined ||
    session.worktreeId != null ||
    session.mainCheckoutLease === true
  );
}

function sessionHoldsHostAssignment(session: SessionRecord, hostId: string): boolean {
  return session.hostId === hostId && sessionOccupiesHostAssignment(session);
}

function hostOccupancyKey(session: SessionRecord): string {
  if (session.worktreeId) return `w:${session.worktreeId}`;
  if (session.mainCheckoutLease) return `c:${session.repositoryId}`;
  return `s:${session.id}`;
}

export function hostHasAssignmentCapacity(state: ControlPlaneState, hostId: string): boolean {
  const connectionId = state.hostConnection.get(hostId);
  const cap = connectionId
    ? state.connections.get(connectionId)?.maxConcurrentAssignments
    : undefined;
  if (cap === undefined) return true;
  return hostAssignmentOccupancyCount(state, hostId) < cap;
}

/** Read-model seed for hosts whose lock predates assignmentCount. */
export function hostAssignmentOccupancyCount(state: ControlPlaneState, hostId: string): number {
  const occupied = new Set<string>();
  for (const session of state.sessions.values()) {
    if (sessionHoldsHostAssignment(session, hostId)) occupied.add(hostOccupancyKey(session));
  }
  for (const worktree of state.worktrees.values()) {
    if (worktree.hostId !== hostId) continue;
    if (worktree.status === "busy" || worktree.currentSessionId) occupied.add(`w:${worktree.id}`);
  }
  for (const key of state.mainCheckoutLeases.keys()) {
    if (key.startsWith(`${hostId}\0`)) occupied.add(`c:${key.slice(hostId.length + 1)}`);
  }
  return occupied.size;
}

export function accountHasLeaseCapacity(
  state: ControlPlaneState,
  providerAccountId: string | undefined,
): boolean {
  if (!providerAccountId) return true;
  if (state.storage) return !accountHasLeaseCapacityOverCap(state, providerAccountId);
  return accountHasLeaseCapacityFromReadModel(state, providerAccountId);
}

/** Legacy hydration can temporarily leave leases in slots beyond a new cap. */
export function accountHasLeaseCapacityOverCap(
  state: ControlPlaneState,
  providerAccountId: string,
): boolean {
  const max = maxConcurrentSessionsFor(state.providerAccounts.get(providerAccountId));
  const holders = new Set<string>();
  for (const lease of state.providerAccountLeases.values()) {
    if (lease.providerAccountId !== providerAccountId) continue;
    if (lease.slot >= max) return true;
    holders.add(lease.sessionId);
  }
  return holders.size > max;
}

/** Availability hints use the running-session read model even in durable mode. */
export function accountHasLeaseCapacityFromReadModel(
  state: ControlPlaneState,
  providerAccountId: string | undefined,
): boolean {
  if (!providerAccountId) return true;
  const max = maxConcurrentSessionsFor(state.providerAccounts.get(providerAccountId));
  const holders = new Set<string>();
  for (const lease of state.providerAccountLeases.values()) {
    if (lease.providerAccountId === providerAccountId) holders.add(lease.sessionId);
  }
  for (const session of state.sessions.values()) {
    const ownsLease =
      session.status === "running" ||
      (session.status === "cancelled" && session.hostId != null) ||
      (session.status === "timed_out" && session.timedOutHostId != null);
    if (ownsLease && session.providerAccountLease?.providerAccountId === providerAccountId) {
      holders.add(session.id);
      continue;
    }
    if (
      (session.status === "running" ||
        (session.status === "cancelled" && session.hostId != null)) &&
      session.resolvedRoute?.providerAccountId === providerAccountId
    ) {
      holders.add(session.id);
    }
  }
  return holders.size < max;
}

export function tryAcquireProviderAccountLeaseLocal(
  state: ControlPlaneState,
  session: SessionRecord,
  providerAccountId: string | undefined,
  attemptId: string,
  hostId: string,
  occupiedSlots: ReadonlySet<number> = new Set(),
  consultLocalMap = true,
): ProviderAccountLease | undefined {
  if (!providerAccountId) return undefined;
  const max = maxConcurrentSessionsFor(state.providerAccounts.get(providerAccountId));
  for (let slot = 0; slot < max; slot += 1) {
    if (occupiedSlots.has(slot)) continue;
    const concurrencyId = providerAccountLeaseConcurrencyId(providerAccountId, slot);
    if (consultLocalMap && state.providerAccountLeases.has(concurrencyId)) continue;
    const lease: ProviderAccountLease = {
      concurrencyId,
      providerAccountId,
      slot,
      attemptId,
    };
    state.providerAccountLeases.set(concurrencyId, {
      sessionId: session.id,
      attemptId,
      slot,
      hostId,
      providerAccountId,
    });
    return lease;
  }
  return undefined;
}

export function providerAccountLeaseWriteOpts(
  session: Pick<SessionRecord, "providerAccountLease"> &
    Partial<Pick<SessionRecord, "hostAssignmentLease">>,
): {
  providerAccountLease?: NonNullable<SessionRecord["providerAccountLease"]>;
  hostAssignmentLease?: NonNullable<SessionRecord["hostAssignmentLease"]>;
} {
  return {
    ...(session.providerAccountLease ? { providerAccountLease: session.providerAccountLease } : {}),
    ...(session.hostAssignmentLease ? { hostAssignmentLease: session.hostAssignmentLease } : {}),
  };
}

/** Idempotent: a second release for the same attempt is a no-op. */
export function releaseProviderAccountLeaseLocal(
  state: ControlPlaneState,
  session: Pick<SessionRecord, "id" | "attemptId" | "providerAccountLease" | "resolvedRoute">,
): boolean {
  const lease = session.providerAccountLease;
  if (!lease) return false;
  const held = state.providerAccountLeases.get(lease.concurrencyId);
  if (!held) return false;
  if (held.sessionId !== session.id || held.attemptId !== lease.attemptId) return false;
  state.providerAccountLeases.delete(lease.concurrencyId);
  return true;
}

export function releaseProviderAccountLease(
  state: ControlPlaneState,
  session: SessionRecord,
): void {
  const lease = session.providerAccountLease;
  if (!lease) {
    delete session.hostAssignmentLease;
    return;
  }
  releaseProviderAccountLeaseLocal(state, session);
  delete session.providerAccountLease;
  delete session.hostAssignmentLease;
  if (state.storage) {
    queueWrite(state, (storage) =>
      storage!.releaseProviderAccountLease({
        concurrencyId: lease.concurrencyId,
        sessionId: session.id,
        attemptId: lease.attemptId,
      }),
    );
  }
}

/** Clear a timeout-preserved lease only after the durable lock/session transaction succeeds. */
export async function releaseTimedOutProviderAccountLease(
  state: ControlPlaneState,
  session: SessionRecord,
): Promise<boolean> {
  const lease = session.providerAccountLease;
  if (!lease) return false;
  if (!state.storage || typeof state.storage.releaseTimedOutProviderAccountLease !== "function") {
    releaseProviderAccountLease(state, session);
    delete session.timedOutHostId;
    return true;
  }
  const released = await state.storage.releaseTimedOutProviderAccountLease({
    concurrencyId: lease.concurrencyId,
    sessionId: session.id,
    attemptId: lease.attemptId,
  });
  if (!released) return false;
  releaseProviderAccountLeaseLocal(state, session);
  delete session.providerAccountLease;
  delete session.hostAssignmentLease;
  delete session.timedOutHostId;
  return true;
}

export async function releaseTimedOutProviderAccountLeasesForHost(
  state: ControlPlaneState,
  hostId: string,
): Promise<string[]> {
  const released: string[] = [];
  for (const session of state.sessions.values()) {
    if (session.status !== "timed_out" || session.timedOutHostId !== hostId) continue;
    if (await releaseTimedOutProviderAccountLease(state, session)) released.push(session.id);
  }
  return released;
}

/** Requeue/terminal paths must drop the attempt-owned slot even if the map was rebuilt. */
export function releaseProviderAccountLeaseForSession(
  state: ControlPlaneState,
  session: SessionRecord,
): SessionRecord {
  if (!session.providerAccountLease) return session;
  releaseProviderAccountLease(state, session);
  const { providerAccountLease: _, hostAssignmentLease: __, ...next } = session;
  return next;
}
