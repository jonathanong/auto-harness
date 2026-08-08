import type { HostInventoryRecord } from "./db/plane-storage.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";
import { persistWorktree, queueWrite } from "./control-plane-state.ts";
import { parseHostBody } from "./control-plane-agent-hosts-parse.ts";
import { findWorktreeNameCollision } from "./control-plane-worktree-names.ts";

function syncWorktreesFromHost(state: ControlPlaneState, host: HostInventoryRecord): void {
  const online = state.agentConnection.has(host.hostId);
  const configuredIds = new Set<string>();
  for (const repo of host.repositories) {
    for (const wt of repo.worktrees) {
      configuredIds.add(wt.id);
      const prev = state.worktrees.get(wt.id);
      persistWorktree(state, {
        id: wt.id,
        name: wt.name,
        hostId: host.hostId,
        repositoryId: repo.id,
        path: wt.path,
        labels: wt.labels,
        status: prev && prev.status === "busy" ? "busy" : "idle",
        online: prev ? prev.online : online,
        currentSessionId: prev && prev.currentSessionId != null ? prev.currentSessionId : null,
        lastAssignedAt: prev && prev.lastAssignedAt != null ? prev.lastAssignedAt : null,
      });
    }
  }
  // Host inventory is authoritative: drop worktrees no longer listed for this agent.
  for (const [id, wt] of state.worktrees) {
    if (wt.hostId === host.hostId && !configuredIds.has(id) && wt.status !== "busy") {
      state.worktrees.delete(id);
    }
  }
}

export function putAgentHostConfig(
  state: ControlPlaneState,
  hostId: string,
  body: unknown,
): { ok: true; config: HostInventoryRecord } | { ok: false; error: string } {
  try {
    const parsed = parseHostBody(hostId, body);
    const collision = findWorktreeNameCollision(state, hostId, parsed);
    if (collision) {
      return { ok: false, error: collision };
    }
    const rec: HostInventoryRecord = { ...parsed, updatedAt: state.now() };
    state.agentHosts.set(hostId, rec);
    if (state.storage) {
      queueWrite(state, state.storage.putAgentHost({ ...rec }));
    }
    syncWorktreesFromHost(state, rec);
    return { ok: true, config: { ...rec } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function getAgentHostConfig(
  state: ControlPlaneState,
  hostId: string,
): HostInventoryRecord | null {
  const rec = state.agentHosts.get(hostId);
  return rec ? { ...rec } : null;
}

export function listAgentHostConfigs(state: ControlPlaneState): HostInventoryRecord[] {
  return [...state.agentHosts.values()]
    .toSorted((a, b) => a.hostId.localeCompare(b.hostId))
    .map((h) => ({ ...h }));
}

export function deleteAgentHostConfig(
  state: ControlPlaneState,
  hostId: string,
): { ok: true } | { ok: false; error: string } {
  if (!state.agentHosts.has(hostId)) {
    return { ok: false, error: "agent host config not found" };
  }
  state.agentHosts.delete(hostId);
  if (state.storage) {
    queueWrite(state, state.storage.deleteAgentHost(hostId));
  }
  // The host is gone entirely, so its worktree names must be released too —
  // otherwise they stay permanently reserved against a host that no longer exists.
  for (const [id, wt] of state.worktrees) {
    if (wt.hostId === hostId) {
      state.worktrees.delete(id);
    }
  }
  return { ok: true };
}
