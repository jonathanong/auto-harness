import type { ConnectionRecord } from "./control-plane-types.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";
import { persistWorktree, queueWrite } from "./control-plane-state.ts";
import { validateRegisterWorktreeNames } from "./control-plane-worktree-names.ts";
import { offlineAgentAndRequeue } from "./control-plane-worktrees.ts";

export function listAgents(state: ControlPlaneState): Array<{
  agentId: string;
  online: boolean;
  lastHeartbeatAt: string | null;
  commandProfiles: string[];
  worktreeIds: string[];
}> {
  const byAgent = new Map<
    string,
    {
      agentId: string;
      online: boolean;
      lastHeartbeatAt: string | null;
      commandProfiles: string[];
      worktreeIds: string[];
    }
  >();
  for (const wt of state.worktrees.values()) {
    const cur = byAgent.get(wt.agentId) ?? {
      agentId: wt.agentId,
      online: false,
      lastHeartbeatAt: null,
      commandProfiles: [] as string[],
      worktreeIds: [] as string[],
    };
    cur.worktreeIds.push(wt.id);
    byAgent.set(wt.agentId, cur);
  }
  for (const conn of state.connections.values()) {
    const cur = byAgent.get(conn.agentId) ?? {
      agentId: conn.agentId,
      online: true,
      lastHeartbeatAt: conn.lastHeartbeatAt,
      commandProfiles: conn.commandProfiles,
      worktreeIds: [] as string[],
    };
    cur.online = true;
    cur.lastHeartbeatAt = conn.lastHeartbeatAt;
    cur.commandProfiles = [...conn.commandProfiles];
    byAgent.set(conn.agentId, cur);
  }
  // Offline hosts with inventory but no live connection still appear in the fleet list.
  for (const host of state.agentHosts.values()) {
    if (!byAgent.has(host.agentId)) {
      byAgent.set(host.agentId, {
        agentId: host.agentId,
        online: false,
        lastHeartbeatAt: null,
        commandProfiles: Object.keys(host.commandProfiles),
        worktreeIds: host.repositories.flatMap((r) => r.worktrees.map((w) => w.id)),
      });
    }
  }
  return [...byAgent.values()].toSorted((a, b) => a.agentId.localeCompare(b.agentId));
}

/**
 * Conditional agent register (Invariant 3): one live connection per agentId.
 * Second register for same agentId fails unless force-replacing is explicit.
 */
export function registerAgent(
  state: ControlPlaneState,
  opts: {
    agentId: string;
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
  const nameError = validateRegisterWorktreeNames(state, opts.agentId, opts.worktrees);
  if (nameError) {
    return { ok: false, error: nameError };
  }

  const existing = state.agentConnection.get(opts.agentId);
  if (existing && !opts.replaceExisting) {
    return {
      ok: false,
      error: `agentId ${opts.agentId} already has an active connection`,
    };
  }
  if (existing) {
    state.connections.delete(existing);
    state.agentConnection.delete(opts.agentId);
  }

  const connectionId = state.connectionIdFactory();
  const at = state.now();
  if (state.storage) {
    const replaceLock = opts.replaceExisting === true || existing !== undefined;
    queueWrite(
      state,
      state.storage
        .tryAcquireAgentLock({
          agentId: opts.agentId,
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
    type: "agent",
    agentId: opts.agentId,
    connectedAt: at,
    lastHeartbeatAt: at,
    commandProfiles: [...opts.commandProfiles],
  };
  state.connections.set(connectionId, conn);
  if (state.storage) {
    queueWrite(state, state.storage.putConnection(conn));
  }
  state.agentConnection.set(opts.agentId, connectionId);
  state.disconnectedAgents.delete(opts.agentId);
  // Re-register clears drain so a restarted agent can take work again.
  state.drainingAgents.delete(opts.agentId);

  for (const wt of opts.worktrees) {
    const prev = state.worktrees.get(wt.id);
    persistWorktree(state, {
      id: wt.id,
      name: wt.name,
      agentId: opts.agentId,
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
    if (wt.agentId === opts.agentId && !opts.worktrees.some((w) => w.id === wt.id)) {
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
  const agentId = conn.agentId;
  state.connections.delete(connectionId);
  if (state.agentConnection.get(agentId) === connectionId) {
    state.agentConnection.delete(agentId);
  }
  state.disconnectedAgents.set(agentId, { lastHeartbeatAt: conn.lastHeartbeatAt });
  return offlineAgentAndRequeue(state, agentId, "agent disconnected; requeued");
}

export function heartbeat(state: ControlPlaneState, agentId: string, at?: string): boolean {
  const connectionId = state.agentConnection.get(agentId);
  if (!connectionId) {
    return false;
  }
  const conn = state.connections.get(connectionId);
  // connectionId always maps to a live connection while agentConnection is consistent
  if (!conn) {
    state.agentConnection.delete(agentId);
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
  agentId: string,
): { ok: boolean; runningSessionIds: string[] } {
  state.drainingAgents.add(agentId);
  const running = [...state.sessions.values()]
    .filter((s) => s.agentId === agentId && s.status === "running")
    .map((s) => s.id);
  state.onAgentMessage?.(agentId, { type: "agent:drain" });
  for (const wt of state.worktrees.values()) {
    if (wt.agentId === agentId) {
      // Idle: offline now. Busy: stay busy until release, then releaseWorktree keeps offline.
      if (wt.status === "idle") {
        wt.online = false;
      }
    }
  }
  return { ok: true, runningSessionIds: running };
}

export function isDraining(state: ControlPlaneState, agentId: string): boolean {
  return state.drainingAgents.has(agentId);
}
