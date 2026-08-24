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
  return occupied.size < cap;
}

export function accountHasLeaseCapacity(
  state: ControlPlaneState,
  providerAccountId: string | undefined,
): boolean {
  if (!providerAccountId) return true;
  if (state.storage) return true;
  const max = maxConcurrentSessionsFor(state.providerAccounts.get(providerAccountId));
  let used = 0;
  for (const lease of state.providerAccountLeases.values()) {
    if (lease.providerAccountId === providerAccountId) used += 1;
  }
  return used < max;
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
  session: Pick<SessionRecord, "providerAccountLease">,
): { providerAccountLease?: NonNullable<SessionRecord["providerAccountLease"]> } {
  return session.providerAccountLease ? { providerAccountLease: session.providerAccountLease } : {};
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
  if (!lease) return;
  releaseProviderAccountLeaseLocal(state, session);
  delete session.providerAccountLease;
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

/** Requeue/terminal paths must drop the attempt-owned slot even if the map was rebuilt. */
export function releaseProviderAccountLeaseForSession(
  state: ControlPlaneState,
  session: SessionRecord,
): SessionRecord {
  if (!session.providerAccountLease) return session;
  releaseProviderAccountLease(state, session);
  const { providerAccountLease: _, ...next } = session;
  return next;
}
