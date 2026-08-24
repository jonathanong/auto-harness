import type { ControlPlaneState } from "./control-plane-state.ts";
import { planSessionTransition, transitionEffect } from "./session-transition-planner.ts";

export function ignoreStaleReconnectClaim(
  state: ControlPlaneState,
  session: import("./db/types.ts").SessionRecord | null | undefined,
  attemptId: string | undefined,
): boolean {
  if (!session || attemptId === undefined) return false;
  return Boolean(
    transitionEffect(
      planSessionTransition(
        session,
        { type: "reconnect_claim", attemptId },
        {
          now: state.now(),
          source: state.storage ? "durable" : "local",
          usageLimitRetryCeiling: state.usageLimitRetryCeiling,
        },
      ),
      "ignore",
    ),
  );
}

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
