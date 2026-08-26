/* eslint-disable max-lines -- provider-account capacity and lease lifecycle share one state helper. */
import {
  isTerminalSessionStatus,
  MAX_CONCURRENT_SESSIONS_LIMIT,
  providerAccountLeaseConcurrencyId,
  type ProviderAccountLeaseReleaseResult,
  type ProviderAccountLeaseState,
} from "@auto-harness/shared";

import type { SessionRecord } from "./db/types.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";
import { queueWrite } from "./control-plane-state.ts";
import { releaseLegacyHostAssignment } from "./control-plane-legacy-host-assignment.ts";
import { maxConcurrentSessionsFor } from "./control-plane-provider-account-capacity.ts";

type ProviderAccountLease = {
  concurrencyId: string;
  providerAccountId: string;
  slot: number;
  attemptId: string;
};

type ProviderAccountLeaseLock = ProviderAccountLease & { sessionId: string; hostId?: string };

type ProviderAccountLeaseOperation =
  | { ok: true; result: ProviderAccountLeaseReleaseResult }
  | { ok: false; reason: "not_found" | "conflict" };

type ProviderAccountLeaseAccess = (session: SessionRecord | undefined) => boolean;

function sessionAttemptId(session: SessionRecord): string | undefined {
  return session.attemptId ?? session.resolvedRoute?.attemptId;
}

function sessionMatchesProviderAccountLease(
  session: SessionRecord | undefined,
  lease: ProviderAccountLeaseLock,
): session is SessionRecord {
  const held = session?.providerAccountLease;
  return (
    session !== undefined &&
    held?.concurrencyId === lease.concurrencyId &&
    held.providerAccountId === lease.providerAccountId &&
    held.slot === lease.slot &&
    held.attemptId === lease.attemptId &&
    sessionAttemptId(session) === lease.attemptId
  );
}

function sessionAssignmentDetached(session: SessionRecord): boolean {
  return (
    session.worktreeId == null &&
    session.mainCheckoutLease !== true &&
    session.assignmentConnectionId === undefined &&
    session.hostAssignmentLease === undefined &&
    session.timedOutHostId === undefined &&
    session.timedOutAssignmentConnectionId === undefined
  );
}

function providerAccountLeaseState(
  lease: ProviderAccountLeaseLock,
  session: SessionRecord | undefined,
): ProviderAccountLeaseState {
  const matches = sessionMatchesProviderAccountLease(session, lease);
  let releaseBlock: NonNullable<ProviderAccountLeaseState["holder"]>["releaseBlock"] = null;
  if (!session) releaseBlock = "session_not_found";
  else if (!matches) releaseBlock = "session_lease_mismatch";
  else if (!isTerminalSessionStatus(session.status)) releaseBlock = "session_not_terminal";
  else if (!sessionAssignmentDetached(session)) releaseBlock = "session_assignment_attached";
  return {
    providerAccountId: lease.providerAccountId,
    slot: lease.slot,
    holder: {
      sessionId: lease.sessionId,
      attemptId: lease.attemptId,
      hostId: session?.hostId ?? lease.hostId ?? null,
      sessionStatus: session?.status ?? null,
      sessionCreatedAt: session?.createdAt ?? null,
      sessionStartedAt: session?.startedAt ?? null,
      releasable: releaseBlock === null,
      releaseBlock,
    },
  };
}

function freeProviderAccountLeaseState(
  providerAccountId: string,
  slot: number,
): ProviderAccountLeaseState {
  return { providerAccountId, slot, holder: null };
}

function localProviderAccountLeaseLock(
  state: ControlPlaneState,
  providerAccountId: string,
  slot: number,
): ProviderAccountLeaseLock | null {
  const concurrencyId = providerAccountLeaseConcurrencyId(providerAccountId, slot);
  const held = state.providerAccountLeases.get(concurrencyId);
  if (held) {
    return {
      concurrencyId,
      providerAccountId: held.providerAccountId,
      slot: held.slot,
      attemptId: held.attemptId,
      sessionId: held.sessionId,
      hostId: held.hostId,
    };
  }
  for (const session of state.sessions.values()) {
    const lease = session.providerAccountLease;
    if (
      lease?.concurrencyId === concurrencyId &&
      lease.providerAccountId === providerAccountId &&
      lease.slot === slot
    ) {
      return {
        ...lease,
        sessionId: session.id,
        ...(session.hostId ? { hostId: session.hostId } : {}),
      };
    }
  }
  return null;
}

/** List every occupied durable provider-account slot, including legacy slots above today's cap. */
export async function listProviderAccountLeaseStates(
  state: ControlPlaneState,
  providerAccountId: string,
  mayAccessSession: ProviderAccountLeaseAccess = () => true,
): Promise<{ ok: true; items: ProviderAccountLeaseState[] } | { ok: false; reason: "not_found" }> {
  if (state.storage) {
    const account = await state.storage.getProviderAccount(providerAccountId);
    if (!account) {
      state.providerAccounts.delete(providerAccountId);
      return { ok: false, reason: "not_found" };
    }
    state.providerAccounts.set(providerAccountId, { ...account });
    const leases = await state.storage.listProviderAccountLeaseLocks(
      providerAccountId,
      MAX_CONCURRENT_SESSIONS_LIMIT,
    );
    const sessions = await state.storage.getProviderAccountLeaseHolderSessions(leases);
    for (const session of sessions.values()) state.sessions.set(session.id, { ...session });
    return {
      ok: true,
      items: leases
        .filter((lease) => {
          const session = sessions.get(lease.sessionId);
          return mayAccessSession(session);
        })
        .map((lease) => providerAccountLeaseState(lease, sessions.get(lease.sessionId)))
        .toSorted((left, right) => left.slot - right.slot),
    };
  }
  if (!state.providerAccounts.has(providerAccountId)) return { ok: false, reason: "not_found" };
  const items: ProviderAccountLeaseState[] = [];
  for (let slot = 0; slot < MAX_CONCURRENT_SESSIONS_LIMIT; slot += 1) {
    const lease = localProviderAccountLeaseLock(state, providerAccountId, slot);
    if (!lease) continue;
    const session = state.sessions.get(lease.sessionId);
    if (mayAccessSession(session)) items.push(providerAccountLeaseState(lease, session));
  }
  return { ok: true, items };
}

async function forceReleaseDurableProviderAccountLease(
  state: ControlPlaneState,
  storage: NonNullable<ControlPlaneState["storage"]>,
  providerAccountId: string,
  slot: number,
  concurrencyId: string,
  mayAccessSession: ProviderAccountLeaseAccess,
): Promise<ProviderAccountLeaseOperation> {
  const account = await storage.getProviderAccount(providerAccountId);
  if (!account) {
    state.providerAccounts.delete(providerAccountId);
    return { ok: false, reason: "not_found" };
  }
  state.providerAccounts.set(providerAccountId, { ...account });
  const lease = await storage.getProviderAccountLeaseLock(concurrencyId);
  if (!lease) {
    const free = freeProviderAccountLeaseState(providerAccountId, slot);
    return { ok: true, result: { released: false, before: free, after: free } };
  }
  const session = await storage.getSession(lease.sessionId, true);
  if (session) state.sessions.set(session.id, { ...session });
  else state.sessions.delete(lease.sessionId);
  const matchedSession = session ?? undefined;
  const before = providerAccountLeaseState(lease, matchedSession);
  if (!mayAccessSession(matchedSession)) {
    return { ok: false, reason: "not_found" };
  }
  if (
    !sessionMatchesProviderAccountLease(matchedSession, lease) ||
    !isTerminalSessionStatus(matchedSession.status) ||
    !sessionAssignmentDetached(matchedSession)
  ) {
    return { ok: false, reason: "conflict" };
  }
  const released = await storage.forceReleaseProviderAccountLease({
    providerAccountId,
    slot,
    concurrencyId,
    sessionId: lease.sessionId,
    attemptId: lease.attemptId,
  });
  if (!released) return { ok: false, reason: "conflict" };
  // Do not mutate either cache until the transaction commits. A stale local map must never
  // advertise capacity after a fenced conditional failure.
  delete matchedSession.providerAccountLease;
  const cachedSession = state.sessions.get(matchedSession.id);
  if (cachedSession && sessionMatchesProviderAccountLease(cachedSession, lease)) {
    delete cachedSession.providerAccountLease;
    state.sessions.set(cachedSession.id, { ...cachedSession });
  }
  const cached = state.providerAccountLeases.get(concurrencyId);
  if (cached?.sessionId === lease.sessionId && cached.attemptId === lease.attemptId) {
    state.providerAccountLeases.delete(concurrencyId);
  }
  const afterLock = await storage.getProviderAccountLeaseLock(concurrencyId);
  const afterSession = afterLock
    ? ((await storage.getSession(afterLock.sessionId, true)) ?? undefined)
    : undefined;
  if (afterLock) {
    state.providerAccountLeases.set(concurrencyId, {
      ...afterLock,
      hostId: afterSession?.hostId ?? afterLock.hostId ?? "",
    });
    if (afterSession) state.sessions.set(afterSession.id, { ...afterSession });
    else state.sessions.delete(afterLock.sessionId);
  }
  const after = afterLock
    ? providerAccountLeaseState(afterLock, afterSession)
    : freeProviderAccountLeaseState(providerAccountId, slot);
  return { ok: true, result: { released: true, before, after } };
}

function forceReleaseLocalProviderAccountLease(
  state: ControlPlaneState,
  providerAccountId: string,
  slot: number,
  concurrencyId: string,
  mayAccessSession: ProviderAccountLeaseAccess,
): ProviderAccountLeaseOperation {
  if (!state.providerAccounts.has(providerAccountId)) return { ok: false, reason: "not_found" };
  const lease = localProviderAccountLeaseLock(state, providerAccountId, slot);
  if (!lease) {
    const free = freeProviderAccountLeaseState(providerAccountId, slot);
    return { ok: true, result: { released: false, before: free, after: free } };
  }
  const session = state.sessions.get(lease.sessionId);
  const before = providerAccountLeaseState(lease, session);
  if (!mayAccessSession(session)) return { ok: false, reason: "not_found" };
  if (
    !sessionMatchesProviderAccountLease(session, lease) ||
    !isTerminalSessionStatus(session.status) ||
    !sessionAssignmentDetached(session)
  ) {
    return { ok: false, reason: "conflict" };
  }
  delete session.providerAccountLease;
  const cached = state.providerAccountLeases.get(concurrencyId);
  if (cached?.sessionId === lease.sessionId && cached.attemptId === lease.attemptId) {
    state.providerAccountLeases.delete(concurrencyId);
  }
  return {
    ok: true,
    result: {
      released: true,
      before,
      after: freeProviderAccountLeaseState(providerAccountId, slot),
    },
  };
}

/** Safely force-release only a terminal session's exact attempt-owned slot. */
export async function forceReleaseProviderAccountLease(
  state: ControlPlaneState,
  providerAccountId: string,
  slot: number,
  mayAccessSession: ProviderAccountLeaseAccess = () => true,
): Promise<ProviderAccountLeaseOperation> {
  const concurrencyId = providerAccountLeaseConcurrencyId(providerAccountId, slot);
  if (state.storage) {
    return forceReleaseDurableProviderAccountLease(
      state,
      state.storage,
      providerAccountId,
      slot,
      concurrencyId,
      mayAccessSession,
    );
  }
  return forceReleaseLocalProviderAccountLease(
    state,
    providerAccountId,
    slot,
    concurrencyId,
    mayAccessSession,
  );
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

export function sessionOccupiesProviderAccountLease(session: SessionRecord): boolean {
  return (
    session.providerAccountLease !== undefined &&
    (session.status === "running" ||
      (session.status === "cancelled" && session.hostId != null) ||
      (session.status === "timed_out" && session.timedOutHostId != null))
  );
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
    if (
      sessionOccupiesProviderAccountLease(session) &&
      session.providerAccountLease?.providerAccountId === providerAccountId
    ) {
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

/**
 * Scheduler refreshes use strongly re-read occupying sessions as the source
 * of truth. Rebuild this local cache rather than letting an old migrated
 * out-of-range slot keep blocking a later assignment after another Lambda
 * completed its durable session.
 */
export function rebuildProviderAccountLeasesFromSessions(state: ControlPlaneState): void {
  state.providerAccountLeases.clear();
  for (const session of state.sessions.values()) {
    const lease = session.providerAccountLease;
    if (!lease || !sessionOccupiesProviderAccountLease(session)) continue;
    state.providerAccountLeases.set(lease.concurrencyId, {
      sessionId: session.id,
      attemptId: lease.attemptId,
      slot: lease.slot,
      hostId: session.hostId ?? session.timedOutHostId ?? "",
      providerAccountId: lease.providerAccountId,
    });
  }
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
  session: Pick<SessionRecord, "providerAccountLease" | "hostAssignmentLease"> &
    Partial<Pick<SessionRecord, "hostId" | "timedOutHostId" | "status" | "resolvedRoute">>,
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
  const attemptId = session.attemptId ?? lease?.attemptId;
  const legacyHostAssignment =
    !session.hostAssignmentLease &&
    session.timedOutHostId &&
    session.timedOutAssignmentConnectionId &&
    attemptId
      ? {
          sessionId: session.id,
          attemptId,
          hostId: session.timedOutHostId,
          connectionId: session.timedOutAssignmentConnectionId,
        }
      : undefined;
  if (!lease) {
    if (
      state.storage &&
      typeof state.storage.releaseTimedOutHostAssignment === "function" &&
      session.timedOutHostId &&
      session.attemptId
    ) {
      const released = await state.storage.releaseTimedOutHostAssignment({
        sessionId: session.id,
        attemptId: session.attemptId,
        hostId: session.timedOutHostId,
        ...(session.hostAssignmentLease
          ? { hostAssignmentLease: session.hostAssignmentLease }
          : {}),
      });
      if (!released) return false;
    }
    if (legacyHostAssignment) await releaseLegacyHostAssignment(state, legacyHostAssignment);
    delete session.hostAssignmentLease;
    delete session.timedOutHostId;
    delete session.timedOutAssignmentConnectionId;
    return true;
  }
  if (!state.storage || typeof state.storage.releaseTimedOutProviderAccountLease !== "function") {
    releaseProviderAccountLease(state, session);
    delete session.timedOutHostId;
    delete session.timedOutAssignmentConnectionId;
    return true;
  }
  const released = await state.storage.releaseTimedOutProviderAccountLease({
    concurrencyId: lease.concurrencyId,
    sessionId: session.id,
    attemptId: lease.attemptId,
    ...(session.hostAssignmentLease ? { hostAssignmentLease: session.hostAssignmentLease } : {}),
  });
  if (!released) return false;
  if (legacyHostAssignment) await releaseLegacyHostAssignment(state, legacyHostAssignment);
  releaseProviderAccountLeaseLocal(state, session);
  delete session.providerAccountLease;
  delete session.hostAssignmentLease;
  delete session.timedOutHostId;
  delete session.timedOutAssignmentConnectionId;
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
