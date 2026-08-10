import type { ControlPlaneState } from "./control-plane-state.ts";

export async function confirmReportedSession(
  state: ControlPlaneState,
  session: import("./db/types.ts").SessionRecord,
  worktree: import("./db/types.ts").WorktreeRecord,
  hostId: string,
  connectionId: string | undefined,
): Promise<boolean> {
  if (state.storage && !connectionId) return false;
  const deadlineAt = session.reconnectDeadlineAt;
  const confirmed =
    !state.storage ||
    (await state.storage.confirmReconnect({
      sessionId: session.id,
      hostId,
      worktreeId: worktree.id,
      ...(deadlineAt ? { deadlineAt } : {}),
      connectionId: connectionId!,
    }));
  if (confirmed) {
    const { reconnectDeadlineAt: _, ...next } = session;
    state.sessions.set(session.id, next);
    state.worktrees.set(worktree.id, {
      ...worktree,
      online: true,
      ...(connectionId ? { connectionId } : {}),
    });
  }
  return confirmed;
}
