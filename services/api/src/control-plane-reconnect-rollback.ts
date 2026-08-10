import type { ControlPlaneState } from "./control-plane-state.ts";

export type ReconnectConfirmation = {
  session: import("./db/types.ts").SessionRecord;
  worktree: import("./db/types.ts").WorktreeRecord;
};

/** Roll back previously-confirmed reports before the registration owner drops
 * its host lease. Every durable restore is fenced by that exact lease, so a
 * replacement that wins first cannot be mutated by the stale rollback. */
export async function restoreConfirmedSessions(
  state: ControlPlaneState,
  hostId: string,
  connectionId: string | undefined,
  confirmed: readonly ReconnectConfirmation[],
): Promise<void> {
  for (const item of confirmed.toReversed()) {
    if (!state.storage) {
      state.sessions.set(item.session.id, item.session);
      state.worktrees.set(item.worktree.id, item.worktree);
      continue;
    }
    if (!connectionId) return;
    const restored = await state.storage.restoreReconnectPending({
      sessionId: item.session.id,
      hostId,
      worktreeId: item.worktree.id,
      connectionId,
      ...(item.session.reconnectDeadlineAt
        ? { previousDeadlineAt: item.session.reconnectDeadlineAt }
        : {}),
      ...(item.session.assignmentConnectionId
        ? { previousAssignmentConnectionId: item.session.assignmentConnectionId }
        : {}),
      ...(item.worktree.connectionId
        ? { previousWorktreeConnectionId: item.worktree.connectionId }
        : {}),
    });
    if (restored) {
      state.sessions.set(item.session.id, item.session);
      state.worktrees.set(item.worktree.id, item.worktree);
    }
  }
}
