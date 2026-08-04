import type { AgentHostRecord } from "./db/plane-storage.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";

/**
 * Worktree names must be unique across every host, not just within one — the
 * fleet-wide worktree map (state.worktrees) is a single global namespace, so
 * two hosts reusing a name would silently overwrite each other's record.
 */
export function findWorktreeNameCollision(
  state: ControlPlaneState,
  agentId: string,
  parsed: Omit<AgentHostRecord, "updatedAt">,
): string | null {
  const namesInBody = new Set<string>();
  for (const repo of parsed.repositories) {
    for (const wt of repo.worktrees) {
      if (namesInBody.has(wt.name)) {
        return `worktree name already used in this same request: ${wt.name}`;
      }
      namesInBody.add(wt.name);
    }
  }
  for (const wt of state.worktrees.values()) {
    if (wt.agentId !== agentId && namesInBody.has(wt.name)) {
      return `worktree name already in use on host ${wt.agentId}: ${wt.name}`;
    }
  }
  return null;
}
