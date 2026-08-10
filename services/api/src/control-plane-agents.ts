/* eslint-disable max-lines */
import type { ConnectionRecord } from "./control-plane-types.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";
import { persistWorktree, queueWrite } from "./control-plane-state.ts";
import { validateRegisterWorktreeNames } from "./control-plane-worktree-names.ts";
import { offlineHostAndRequeue, offlineHostAndRequeueDurable } from "./control-plane-worktrees.ts";
import { reconcileHostRunningSessions } from "./control-plane-reconnect.ts";

/** Undo a registration after its lease committed but its reconciliation did
 * not. Every write and cache mutation remains fenced by the candidate
 * connection, so an intervening replacement keeps its own inventory. */
async function rollbackDurableRegistration(
  state: ControlPlaneState,
  hostId: string,
  connectionId: string,
  at: string,
  worktrees: readonly import("./db/types.ts").WorktreeRecord[],
): Promise<void> {
  const storage = state.storage!;
  try {
    const ownedWorktrees = new Map(worktrees.map((worktree) => [worktree.id, worktree]));
    // Reconciliation can release an omitted running session while this
    // registration still owns the lease. Those rows are stamped with this
    // connection in the same transaction, so include them in rollback too.
    for (const worktree of await storage.listWorktreesByHost(hostId)) {
      if (worktree.connectionId === connectionId) {
        ownedWorktrees.set(worktree.id, worktree);
      }
    }
    for (const worktree of ownedWorktrees.values()) {
      if (
        await storage.setWorktreeOnlineFenced(worktree.id, connectionId, false, {
          hostId,
          connectionId,
        })
      ) {
        state.worktrees.set(worktree.id, { ...worktree, online: false });
      }
    }
  } finally {
    const released = await storage.releaseHostConnection(hostId, connectionId);
    const durableOwner = await storage.getHostLock(hostId);
    const ownsLocalHost = state.hostConnection.get(hostId) === connectionId;

    // Delete only this failed connection. In-process replacements remain
    // mapped to the host; a durable-only replacement makes our old cache
    // safely offline without declaring that replacement disconnected.
    state.connections.delete(connectionId);
    if (ownsLocalHost) {
      state.hostConnection.delete(hostId);
      if (released && durableOwner === null) {
        state.disconnectedHosts.set(hostId, { lastHeartbeatAt: at });
      }
    }
  }
}

function validateRunningSessions(
  state: ControlPlaneState,
  hostId: string,
  reported: readonly string[] | undefined,
): string | null {
  const seen = new Set<string>();
  for (const sessionId of reported ?? []) {
    if (seen.has(sessionId)) return `duplicate running session ${sessionId}`;
    seen.add(sessionId);
    const session = state.sessions.get(sessionId);
    const worktree = session?.worktreeId ? state.worktrees.get(session.worktreeId) : undefined;
    if (
      !session ||
      session.status !== "running" ||
      !session.ackReceivedAt ||
      session.hostId !== hostId ||
      !session.worktreeId ||
      !worktree ||
      worktree.hostId !== hostId ||
      worktree.currentSessionId !== sessionId
    ) {
      return `running session ${sessionId} is not owned by host ${hostId}`;
    }
  }
  return null;
}

async function validateRunningSessionsDurable(
  state: ControlPlaneState,
  hostId: string,
  reported: readonly string[] | undefined,
): Promise<string | null> {
  const seen = new Set<string>();
  for (const sessionId of reported ?? []) {
    if (seen.has(sessionId)) return `duplicate running session ${sessionId}`;
    seen.add(sessionId);
    const session = await state.storage!.getSession(sessionId);
    const worktree = session?.worktreeId
      ? await state.storage!.getWorktree(session.worktreeId)
      : null;
    if (
      !session ||
      session.status !== "running" ||
      !session.ackReceivedAt ||
      session.hostId !== hostId ||
      !session.worktreeId ||
      !worktree ||
      worktree.hostId !== hostId ||
      worktree.currentSessionId !== sessionId
    ) {
      return `running session ${sessionId} is not owned by host ${hostId}`;
    }
  }
  return null;
}

export function listHosts(state: ControlPlaneState): Array<{
  hostId: string;
  online: boolean;
  lastHeartbeatAt: string | null;
  commandProfiles: string[];
  worktreeIds: string[];
}> {
  const byHost = new Map<
    string,
    {
      hostId: string;
      online: boolean;
      lastHeartbeatAt: string | null;
      commandProfiles: string[];
      worktreeIds: string[];
    }
  >();
  for (const wt of state.worktrees.values()) {
    const cur = byHost.get(wt.hostId) ?? {
      hostId: wt.hostId,
      online: false,
      lastHeartbeatAt: null,
      commandProfiles: [] as string[],
      worktreeIds: [] as string[],
    };
    cur.worktreeIds.push(wt.id);
    byHost.set(wt.hostId, cur);
  }
  for (const conn of state.connections.values()) {
    const cur = byHost.get(conn.hostId) ?? {
      hostId: conn.hostId,
      online: true,
      lastHeartbeatAt: conn.lastHeartbeatAt,
      commandProfiles: conn.commandProfiles,
      worktreeIds: [] as string[],
    };
    cur.online = true;
    cur.lastHeartbeatAt = conn.lastHeartbeatAt;
    cur.commandProfiles = [...conn.commandProfiles];
    byHost.set(conn.hostId, cur);
  }
  // Offline hosts with inventory but no live connection still appear in the fleet list.
  for (const host of state.hostInventories.values()) {
    if (!byHost.has(host.hostId)) {
      byHost.set(host.hostId, {
        hostId: host.hostId,
        online: false,
        lastHeartbeatAt: null,
        commandProfiles: Object.keys(host.commandProfiles),
        worktreeIds: host.repositories.flatMap((r) => r.worktrees.map((w) => w.id)),
      });
    }
  }
  return [...byHost.values()].toSorted((a, b) => a.hostId.localeCompare(b.hostId));
}

/**
 * Conditional agent register (Invariant 3): one live connection per hostId.
 * Second register for same hostId fails unless force-replacing is explicit.
 */
export function registerHost(
  state: ControlPlaneState,
  opts: {
    hostId: string;
    worktrees: Array<{
      id: string;
      name: string;
      repositoryId: string;
      path: string;
      labels: string[];
    }>;
    commandProfiles: string[];
    runningSessions?: string[];
    replaceExisting?: boolean;
  },
): { ok: true; connectionId: string } | { ok: false; error: string } {
  const nameError = validateRegisterWorktreeNames(state, opts.hostId, opts.worktrees);
  if (nameError) {
    return { ok: false, error: nameError };
  }
  const runningError = validateRunningSessions(state, opts.hostId, opts.runningSessions);
  if (runningError) return { ok: false, error: runningError };

  const existing = state.hostConnection.get(opts.hostId);
  if (existing && !opts.replaceExisting) {
    return {
      ok: false,
      error: `hostId ${opts.hostId} already has an active connection`,
    };
  }
  if (existing) {
    state.connections.delete(existing);
    state.hostConnection.delete(opts.hostId);
  }

  const connectionId = state.connectionIdFactory();
  const at = state.now();
  if (state.storage) {
    const replaceLock = opts.replaceExisting === true || existing !== undefined;
    queueWrite(
      state,
      state.storage
        .tryAcquireHostLock({
          hostId: opts.hostId,
          connectionId,
          replaceExisting: replaceLock,
        })
        .then(() => {
          /* lock written */
        }),
    );
  }
  const conn: ConnectionRecord = {
    connectionId,
    type: "host",
    hostId: opts.hostId,
    connectedAt: at,
    lastHeartbeatAt: at,
    commandProfiles: [...opts.commandProfiles],
  };
  state.connections.set(connectionId, conn);
  if (state.storage) {
    queueWrite(state, state.storage.putConnection(conn));
  }
  state.hostConnection.set(opts.hostId, connectionId);
  state.disconnectedHosts.delete(opts.hostId);
  // Re-register clears drain so a restarted agent can take work again.
  state.drainingHosts.delete(opts.hostId);

  for (const wt of opts.worktrees) {
    const prev = state.worktrees.get(wt.id);
    if (prev?.status === "busy") continue;
    persistWorktree(state, {
      id: wt.id,
      name: wt.name,
      hostId: opts.hostId,
      repositoryId: wt.repositoryId,
      path: wt.path,
      labels: wt.labels,
      status: "idle",
      online: true,
      currentSessionId: prev && prev.currentSessionId != null ? prev.currentSessionId : null,
      lastAssignedAt: prev && prev.lastAssignedAt != null ? prev.lastAssignedAt : null,
      connectionId,
    });
  }
  for (const wt of state.worktrees.values()) {
    if (
      wt.hostId === opts.hostId &&
      wt.status !== "busy" &&
      !opts.worktrees.some((w) => w.id === wt.id)
    ) {
      wt.online = true;
      persistWorktree(state, { ...wt, connectionId });
    }
  }
  void reconcileHostRunningSessions(state, opts.hostId, opts.runningSessions ?? []);
  return { ok: true, connectionId };
}

/** Durable registration. The host lease and connection row are committed
 * before the process cache is replaced, so a rejected replacement cannot
 * evict the currently valid socket from this process. */
export async function registerHostDurable(
  state: ControlPlaneState,
  opts: {
    hostId: string;
    worktrees: Array<{
      id: string;
      name: string;
      repositoryId: string;
      path: string;
      labels: string[];
    }>;
    commandProfiles: string[];
    runningSessions?: string[];
    replaceExisting?: boolean;
  },
): Promise<{ ok: true; connectionId: string } | { ok: false; error: string }> {
  if (!state.storage) {
    return registerHost(state, opts);
  }
  const nameError = validateRegisterWorktreeNames(state, opts.hostId, opts.worktrees);
  if (nameError) {
    return { ok: false, error: nameError };
  }
  const runningError = await validateRunningSessionsDurable(
    state,
    opts.hostId,
    opts.runningSessions,
  );
  if (runningError) return { ok: false, error: runningError };
  const existing = state.hostConnection.get(opts.hostId);
  if (existing && !opts.replaceExisting) {
    return { ok: false, error: `hostId ${opts.hostId} already has an active connection` };
  }
  const connectionId = state.connectionIdFactory();
  const at = state.now();
  const conn: ConnectionRecord = {
    connectionId,
    type: "host",
    hostId: opts.hostId,
    connectedAt: at,
    lastHeartbeatAt: at,
    commandProfiles: [...opts.commandProfiles],
  };
  const won = await state.storage.tryRegisterHost({
    hostId: opts.hostId,
    connection: conn,
    replaceExisting: opts.replaceExisting === true,
    ...(existing ? { existingConnectionId: existing } : {}),
  });
  if (!won) {
    return { ok: false, error: `hostId ${opts.hostId} already has an active connection` };
  }
  // The transaction committed. Finish all related row writes before changing
  // this process's cache; a failed inventory/worktree write must not make the
  // cache claim a state that was never durably persisted.
  const nextWorktrees = [] as Array<import("./db/types.ts").WorktreeRecord>;
  for (const wt of opts.worktrees) {
    const prev = (await state.storage.getWorktree(wt.id)) ?? state.worktrees.get(wt.id);
    if (prev?.status === "busy") continue;
    const next = {
      id: wt.id,
      name: wt.name,
      hostId: opts.hostId,
      repositoryId: wt.repositoryId,
      path: wt.path,
      labels: wt.labels,
      status: "idle" as const,
      online: true,
      currentSessionId: prev?.currentSessionId ?? null,
      lastAssignedAt: prev?.lastAssignedAt ?? null,
      connectionId,
    };
    nextWorktrees.push(next);
  }
  // The durable inventory, not this API process's cache, is the source for
  // worktrees omitted by a refreshed daemon snapshot. A stale process must
  // still stamp safe idle rows with its exact new lease, while busy rows stay
  // exclusively owned by reconciliation.
  const registeredIds = new Set(opts.worktrees.map((worktree) => worktree.id));
  for (const existingWorktree of await state.storage.listWorktreesByHost(opts.hostId)) {
    if (registeredIds.has(existingWorktree.id) || existingWorktree.status === "busy") continue;
    nextWorktrees.push({ ...existingWorktree, online: true, connectionId });
  }
  try {
    for (const next of nextWorktrees) {
      if (!(await state.storage.putWorktreeFenced(next, { hostId: opts.hostId, connectionId }))) {
        await state.storage.releaseHostConnection(opts.hostId, connectionId);
        return { ok: false, error: "host connection changed while publishing inventory" };
      }
    }
  } catch (err) {
    // The lease+connection transaction has already committed, but no local
    // process has adopted it until inventory persistence succeeds. Release
    // exactly this lease so a transient write failure cannot strand a host.
    await state.storage.releaseHostConnection(opts.hostId, connectionId);
    throw err;
  }
  if (existing) {
    state.connections.delete(existing);
  }
  state.connections.set(connectionId, conn);
  state.hostConnection.set(opts.hostId, connectionId);
  state.disconnectedHosts.delete(opts.hostId);
  state.drainingHosts.delete(opts.hostId);
  for (const next of nextWorktrees) {
    state.worktrees.set(next.id, next);
  }
  let reconciled: string[] | false;
  try {
    reconciled = await reconcileHostRunningSessions(state, opts.hostId, opts.runningSessions ?? []);
  } catch (err) {
    // Reconciliation reads and its rollback writes are durable operations too.
    // Do not strand the just-acquired lease if any of those operations fail.
    await rollbackDurableRegistration(state, opts.hostId, connectionId, at, nextWorktrees);
    throw err;
  }
  if (reconciled === false) {
    // The lease is ours, but a concurrently-expired session was requeued
    // before it could be confirmed.  Do not publish this half-registration:
    // first restore reconciliation/inventory state while the exact lease is
    // still held, then release it. A replacement must never be offlined by a
    // stale cleanup that ran after dropping its authority.
    await rollbackDurableRegistration(state, opts.hostId, connectionId, at, nextWorktrees);
    return { ok: false, error: "reported running session lost reconnect reconciliation" };
  }
  return { ok: true, connectionId };
}

/**
 * Agent disconnect ($disconnect / crash). Immediately:
 * - marks ALL worktrees offline
 * - requeues running sessions and frees busy worktrees
 * - records disconnectedHosts so assigns cannot bind until re-register
 */
export function disconnectHost(state: ControlPlaneState, connectionId: string): string[] {
  const conn = state.connections.get(connectionId);
  if (!conn) {
    return [];
  }
  const hostId = conn.hostId;
  state.connections.delete(connectionId);
  if (state.hostConnection.get(hostId) === connectionId) {
    state.hostConnection.delete(hostId);
  }
  state.disconnectedHosts.set(hostId, { lastHeartbeatAt: conn.lastHeartbeatAt });
  return offlineHostAndRequeue(state, hostId, "agent disconnected; requeued");
}

/** Durable disconnect cleans only work stamped by its exact lease, then
 * conditionally releases that lease. A replacement can win either race
 * without an old socket touching the replacement's inventory. */
export async function disconnectHostDurable(
  state: ControlPlaneState,
  connectionId: string,
): Promise<string[]> {
  if (!state.storage) {
    return disconnectHost(state, connectionId);
  }
  const conn = state.connections.get(connectionId);
  if (!conn) {
    return [];
  }
  if ((await state.storage.getHostLock(conn.hostId)) !== connectionId) {
    await state.storage.deleteConnection(connectionId);
    state.connections.delete(connectionId);
    if (state.hostConnection.get(conn.hostId) === connectionId) {
      state.hostConnection.delete(conn.hostId);
    }
    return [];
  }
  const requeued = await offlineHostAndRequeueDurable(
    state,
    conn.hostId,
    connectionId,
    "agent disconnected; requeued",
  );
  const released = await state.storage.releaseHostConnection(conn.hostId, connectionId);
  // releaseHostConnection's transaction cannot delete the connection row if
  // a replacement won its lock condition. The old connection id is globally
  // unique, so deleting that orphan cannot affect the replacement lease.
  await state.storage.deleteConnection(connectionId);
  state.connections.delete(connectionId);
  if (state.hostConnection.get(conn.hostId) === connectionId) {
    state.hostConnection.delete(conn.hostId);
  }
  if (!released) return requeued;
  state.disconnectedHosts.set(conn.hostId, { lastHeartbeatAt: conn.lastHeartbeatAt });
  return requeued;
}

export function heartbeat(state: ControlPlaneState, hostId: string, at?: string): boolean {
  const connectionId = state.hostConnection.get(hostId);
  if (!connectionId) {
    return false;
  }
  const conn = state.connections.get(connectionId);
  // connectionId always maps to a live connection while agentConnection is consistent
  if (!conn) {
    state.hostConnection.delete(hostId);
    return false;
  }
  conn.lastHeartbeatAt = at ?? state.now();
  return true;
}

export async function heartbeatDurable(
  state: ControlPlaneState,
  hostId: string,
  at?: string,
): Promise<boolean> {
  if (!state.storage) {
    return heartbeat(state, hostId, at);
  }
  const connectionId = state.hostConnection.get(hostId);
  if (!connectionId || !state.connections.has(connectionId)) {
    return false;
  }
  const nextAt = at ?? state.now();
  const updated = await state.storage.heartbeatConnection(hostId, connectionId, nextAt);
  if (!updated) {
    return false;
  }
  const conn = state.connections.get(connectionId);
  if (conn) {
    state.connections.set(connectionId, { ...conn, lastHeartbeatAt: nextAt });
  }
  return true;
}

/**
 * Phase 5: mark agent draining — no new assigns until re-register.
 * Sticky: released busy worktrees stay offline via releaseWorktree.
 */
export function drainHost(
  state: ControlPlaneState,
  hostId: string,
): { ok: boolean; runningSessionIds: string[] } {
  state.drainingHosts.add(hostId);
  const running = [...state.sessions.values()]
    .filter((s) => s.hostId === hostId && s.status === "running")
    .map((s) => s.id);
  state.onHostMessage?.(hostId, { type: "host:drain" });
  for (const wt of state.worktrees.values()) {
    if (wt.hostId === hostId) {
      // Idle: offline now. Busy: stay busy until release, then releaseWorktree keeps offline.
      if (wt.status === "idle") {
        wt.online = false;
      }
    }
  }
  return { ok: true, runningSessionIds: running };
}

/**
 * Storage-backed drain. The lease flag is committed before publishing
 * `host:drain`, and every durable assignment checks that same flag in its
 * transaction. That closes the stale-cache window between candidate selection
 * and assignment without trusting process-local `drainingHosts` state.
 */
export async function drainHostDurable(
  state: ControlPlaneState,
  hostId: string,
): Promise<{ ok: boolean; runningSessionIds: string[] }> {
  if (!state.storage) {
    return drainHost(state, hostId);
  }
  // A freshly hydrated API process may have worktrees but not the owning
  // socket in its local map. The durable lease is authoritative for drain,
  // just as it is for assignment.
  const connectionId =
    state.hostConnection.get(hostId) ?? (await state.storage.getHostLock(hostId));
  if (connectionId) {
    const marked = await state.storage.markHostDraining(hostId, connectionId);
    if (!marked) {
      return { ok: false, runningSessionIds: [] };
    }
  }

  state.drainingHosts.add(hostId);
  const running = [...state.sessions.values()]
    .filter((s) => s.hostId === hostId && s.status === "running")
    .map((s) => s.id);
  for (const wt of state.worktrees.values()) {
    if (wt.hostId !== hostId || wt.status !== "idle") {
      continue;
    }
    // Keep the durable inventory truthful for readers and restart hydration.
    // The preceding lock transition is the scheduler authority if a write
    // races or a second process has a stale worktree cache.
    await state.storage.setWorktreeOnline(wt.id, false);
    state.worktrees.set(wt.id, { ...wt, online: false });
  }
  state.onHostMessage?.(hostId, { type: "host:drain" });
  return { ok: true, runningSessionIds: running };
}

export function isDraining(state: ControlPlaneState, hostId: string): boolean {
  return state.drainingHosts.has(hostId);
}
