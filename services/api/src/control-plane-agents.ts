/* eslint-disable max-lines */
import type { ConnectionRecord } from "./control-plane-types.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";
import { persistWorktree, queueWrite } from "./control-plane-state.ts";
import { validateRegisterWorktreeNames } from "./control-plane-worktree-names.ts";
import { offlineHostAndRequeue, offlineHostAndRequeueDurable } from "./control-plane-worktrees.ts";

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
    replaceExisting?: boolean;
  },
): { ok: true; connectionId: string } | { ok: false; error: string } {
  const nameError = validateRegisterWorktreeNames(state, opts.hostId, opts.worktrees);
  if (nameError) {
    return { ok: false, error: nameError };
  }

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
    persistWorktree(state, {
      id: wt.id,
      name: wt.name,
      hostId: opts.hostId,
      repositoryId: wt.repositoryId,
      path: wt.path,
      labels: wt.labels,
      status: prev && prev.status === "busy" ? "busy" : "idle",
      online: true,
      currentSessionId: prev && prev.currentSessionId != null ? prev.currentSessionId : null,
      lastAssignedAt: prev && prev.lastAssignedAt != null ? prev.lastAssignedAt : null,
    });
  }
  for (const wt of state.worktrees.values()) {
    if (wt.hostId === opts.hostId && !opts.worktrees.some((w) => w.id === wt.id)) {
      wt.online = true;
      persistWorktree(state, { ...wt });
    }
  }
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
    const prev = state.worktrees.get(wt.id);
    const next = {
      id: wt.id,
      name: wt.name,
      hostId: opts.hostId,
      repositoryId: wt.repositoryId,
      path: wt.path,
      labels: wt.labels,
      status: prev?.status === "busy" ? ("busy" as const) : ("idle" as const),
      online: true,
      currentSessionId: prev?.currentSessionId ?? null,
      lastAssignedAt: prev?.lastAssignedAt ?? null,
    };
    nextWorktrees.push(next);
  }
  for (const wt of state.worktrees.values()) {
    if (wt.hostId === opts.hostId && !opts.worktrees.some((w) => w.id === wt.id)) {
      nextWorktrees.push({ ...wt, online: true });
    }
  }
  try {
    for (const next of nextWorktrees) {
      await state.storage.putWorktree(next);
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

/** Durable disconnect: release the lease before changing local ownership. */
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
  const released = await state.storage.releaseHostConnection(conn.hostId, connectionId);
  if (!released) {
    return [];
  }
  state.connections.delete(connectionId);
  if (state.hostConnection.get(conn.hostId) === connectionId) {
    state.hostConnection.delete(conn.hostId);
  }
  state.disconnectedHosts.set(conn.hostId, { lastHeartbeatAt: conn.lastHeartbeatAt });
  return offlineHostAndRequeueDurable(state, conn.hostId, "agent disconnected; requeued");
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

export function isDraining(state: ControlPlaneState, hostId: string): boolean {
  return state.drainingHosts.has(hostId);
}
