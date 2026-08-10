import type { ControlPlaneState } from "./control-plane-state.ts";
import { queueReconnectSession } from "./control-plane-reconnect-session.ts";

export async function protectScheduledRunsForFailedRegistration(
  state: ControlPlaneState,
  hostId: string,
): Promise<void> {
  const storage = state.storage!;
  const sessions =
    typeof (storage as { listSessionsByHost?: unknown }).listSessionsByHost === "function"
      ? await storage.listSessionsByHost(hostId)
      : [...state.sessions.values()].filter((session) => session.hostId === hostId);
  for (const session of sessions) {
    if (
      session.status !== "running" ||
      !session.mainCheckoutLease ||
      !session.assignmentConnectionId
    )
      continue;
    if (session.ackReceivedAt) {
      if (session.reconnectDeadlineAt) continue;
      const deadlineAt = new Date(Date.parse(state.now()) + state.reconnectGraceMs).toISOString();
      const marked = await storage.markMainCheckoutReconnectPending({
        sessionId: session.id,
        hostId,
        repositoryId: session.repositoryId,
        connectionId: session.assignmentConnectionId,
        deadlineAt,
      });
      if (marked) {
        state.sessions.set(session.id, { ...session, reconnectDeadlineAt: deadlineAt });
        continue;
      }
    }
    const released = await storage.releaseMainCheckoutSession({
      sessionId: session.id,
      hostId,
      repositoryId: session.repositoryId,
      connectionId: session.assignmentConnectionId,
      status: "queued",
      queueShard: session.queueShard,
      reason: "replacement registration failed; requeued",
    });
    if (released) {
      state.sessions.set(
        session.id,
        queueReconnectSession(session, "replacement registration failed; requeued"),
      );
      state.pendingAcks.delete(session.id);
      continue;
    }
    const current = await storage.getSession(session.id);
    if (
      current?.status === "running" &&
      current.mainCheckoutLease &&
      current.assignmentConnectionId === session.assignmentConnectionId &&
      !current.reconnectDeadlineAt
    )
      throw new Error(`could not protect scheduled session ${session.id} during rollback`);
  }
}
