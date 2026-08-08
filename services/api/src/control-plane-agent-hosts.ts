import type { AgentHostRecord } from "./db/plane-storage.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";
import { persistWorktree, queueWrite } from "./control-plane-state.ts";
import { parseHostBody } from "./control-plane-agent-hosts-parse.ts";
import { findWorktreeNameCollision } from "./control-plane-worktree-names.ts";

function syncWorktreesFromHost(state: ControlPlaneState, host: AgentHostRecord): void {
  const online = state.agentConnection.has(host.agentId);
  const configuredIds = new Set<string>();
  for (const repo of host.repositories) {
    for (const wt of repo.worktrees) {
      configuredIds.add(wt.id);
      const prev = state.worktrees.get(wt.id);
      persistWorktree(state, {
        id: wt.id,
        name: wt.name,
        agentId: host.agentId,
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
    if (wt.agentId === host.agentId && !configuredIds.has(id) && wt.status !== "busy") {
      state.worktrees.delete(id);
    }
  }
}

export function putAgentHostConfig(
  state: ControlPlaneState,
  agentId: string,
  body: unknown,
): { ok: true; config: AgentHostRecord } | { ok: false; error: string } {
  try {
    const parsed = parseHostBody(agentId, body);
    const collision = findWorktreeNameCollision(state, agentId, parsed);
    if (collision) {
      return { ok: false, error: collision };
    }
    const rec: AgentHostRecord = { ...parsed, updatedAt: state.now() };
    state.agentHosts.set(agentId, rec);
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
  agentId: string,
): AgentHostRecord | null {
  const rec = state.agentHosts.get(agentId);
  return rec ? { ...rec } : null;
}

export function listAgentHostConfigs(state: ControlPlaneState): AgentHostRecord[] {
  return [...state.agentHosts.values()]
    .toSorted((a, b) => a.agentId.localeCompare(b.agentId))
    .map((h) => ({ ...h }));
}

export function deleteAgentHostConfig(
  state: ControlPlaneState,
  agentId: string,
): { ok: true } | { ok: false; error: string } {
  if (!state.agentHosts.has(agentId)) {
    return { ok: false, error: "agent host config not found" };
  }
  state.agentHosts.delete(agentId);
  if (state.storage) {
    queueWrite(state, state.storage.deleteAgentHost(agentId));
  }
  // The host is gone entirely, so its worktree names must be released too —
  // otherwise they stay permanently reserved against a host that no longer exists.
  for (const [id, wt] of state.worktrees) {
    if (wt.agentId === agentId) {
      state.worktrees.delete(id);
    }
  }
  return { ok: true };
}
