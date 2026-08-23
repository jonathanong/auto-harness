import type { ControlPlaneState } from "./control-plane-state.ts";
import { persistWorktree } from "./control-plane-state.ts";

export function releaseWorktree(state: ControlPlaneState, worktreeId: string): void {
  const wt = state.worktrees.get(worktreeId);
  if (!wt) return;
  wt.status = "idle";
  wt.currentSessionId = null;
  // Drain / disconnect are sticky: released worktrees must not become assignable.
  if (state.drainingHosts.has(wt.hostId) || state.disconnectedHosts.has(wt.hostId)) {
    wt.online = false;
  }
  persistWorktree(state, { ...wt });
}
