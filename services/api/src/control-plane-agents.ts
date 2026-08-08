import type { ConnectionRecord } from "./control-plane-types.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";
import { persistWorktree, queueWrite } from "./control-plane-state.ts";
import { validateRegisterWorktreeNames } from "./control-plane-worktree-names.ts";
import { offlineAgentAndRequeue } from "./control-plane-worktrees.ts";

export function listAgents(state: ControlPlaneState): Array<{
  hostId: string;
  online: boolean;
  lastHeartbeatAt: string | null;
  commandProfiles: string[];
  worktreeIds: string[];
}> {
  const byAgent = new Map<
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
    const cur = byAgent.get(wt.hostId) ?? {
      hostId: wt.hostId,
      online: false,
      lastHeartbeatAt: null,
      commandProfiles: [] as string[],
      worktreeIds: [] as string[],
    };
    cur.worktreeIds.push(wt.id);
    byAgent.set(wt.hostId, cur);
  }
  for (const conn of state.connections.values()) {
    const cur = byAgent.get(conn.hostId) ?? {
      hostId: conn.hostId,
      online: true,
      lastHeartbeatAt: conn.lastHeartbeatAt,
      commandProfiles: conn.commandProfiles,
      worktreeIds: [] as string[],
    };
    cur.online = true;
    cur.lastHeartbeatAt = conn.lastHeartbeatAt;
    cur.commandProfiles = [...conn.commandProfiles];
    byAgent.set(conn.hostId, cur);
  }
  // Offline hosts with inventory but no live connection still appear in the fleet list.
  for (const host of state.agentHosts.values()) {
    if (!byAgent.has(host.hostId)) {
      byAgent.set(host.hostId, {
        hostId: host.hostId,
        online: false,
        lastHeartbeatAt: null,
        commandProfiles: Object.keys(host.commandProfiles),
        worktreeIds: host.repositories.flatMap((r) => r.worktrees.map((w) => w.id)),
      });
    }
  }
  return [...byAgent.values()].toSorted((a, b) => a.hostId.localeCompare(b.hostId));
}

/**
 * Conditional agent register (Invariant 3): one live connection per hostId.
 * Second register for same hostId fails unless force-replacing is explicit.
 */
export function registerAgent(
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

  const existing = state.agentConnection.get(opts.hostId);
  if (existing && !opts.replaceExisting) {
    return {
      ok: false,
      error: `hostId ${opts.hostId} already has an active connection`,
    };
  }
  if (existing) {
    state.connections.delete(existing);
    state.agentConnection.delete(opts.hostId);
  }

  const connectionId = state.connectionIdFactory();
  const at = state.now();
  if (state.storage) {
    const replaceLock = opts.replaceExisting === true || existing !== undefined;
    queueWrite(
      state,
      state.storage
        .tryAcquireAgentLock({
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
  state.agentConnection.set(opts.hostId, connectionId);
  state.disconnectedAgents.delete(opts.hostId);
  // Re-register clears drain so a restarted agent can take work again.
  state.drainingAgents.delete(opts.hostId);

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

/**
 * Agent disconnect ($disconnect / crash). Immediately:
 * - marks ALL worktrees offline
 * - requeues running sessions and frees busy worktrees
 * - records disconnectedAgents so assigns cannot bind until re-register
 */
export function disconnectAgent(state: ControlPlaneState, connectionId: string): string[] {
  const conn = state.connections.get(connectionId);
  if (!conn) {
    return [];
  }
  const hostId = conn.hostId;
  state.connections.delete(connectionId);
  if (state.agentConnection.get(hostId) === connectionId) {
    state.agentConnection.delete(hostId);
  }
  state.disconnectedAgents.set(hostId, { lastHeartbeatAt: conn.lastHeartbeatAt });
  return offlineAgentAndRequeue(state, hostId, "agent disconnected; requeued");
}

export function heartbeat(state: ControlPlaneState, hostId: string, at?: string): boolean {
  const connectionId = state.agentConnection.get(hostId);
  if (!connectionId) {
    return false;
  }
  const conn = state.connections.get(connectionId);
  // connectionId always maps to a live connection while agentConnection is consistent
  if (!conn) {
    state.agentConnection.delete(hostId);
    return false;
  }
  conn.lastHeartbeatAt = at ?? state.now();
  return true;
}

/**
 * Phase 5: mark agent draining — no new assigns until re-register.
 * Sticky: released busy worktrees stay offline via releaseWorktree.
 */
export function drainAgent(
  state: ControlPlaneState,
  hostId: string,
): { ok: boolean; runningSessionIds: string[] } {
  state.drainingAgents.add(hostId);
  const running = [...state.sessions.values()]
    .filter((s) => s.hostId === hostId && s.status === "running")
    .map((s) => s.id);
  state.onAgentMessage?.(hostId, { type: "host:drain" });
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
  return state.drainingAgents.has(hostId);
}
