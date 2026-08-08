import { isValidSlugName, SLUG_NAME_HINT } from "@auto-harness/shared";

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

/**
 * Same invariant as findWorktreeNameCollision, for the flat worktree array shape
 * used by the WS `agent:register` path — this is a separate wire protocol from
 * the HTTP PUT host-config path, so it needs its own slug + collision validation
 * rather than trusting the caller to have already checked (registerAgent is
 * reachable by any client speaking the raw WS protocol, not just the bundled agent).
 */
export function validateRegisterWorktreeNames(
  state: ControlPlaneState,
  agentId: string,
  worktrees: Array<{ id: string; name: string; path: string; labels: string[] }>,
): string | null {
  for (const wt of worktrees) {
    if (!isValidSlugName(wt.name)) {
      return `worktree.${wt.id}.name must be ${SLUG_NAME_HINT}`;
    }
  }
  return findWorktreeNameCollision(state, agentId, {
    agentId,
    repositories: [{ id: "_", path: "_", defaultBranch: "main", worktrees }],
    providerAccounts: [],
    commandProfiles: {},
  });
}
