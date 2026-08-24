import type { ControlPlaneState } from "./control-plane-state.ts";
import { releaseScheduledLeaseLocal } from "./control-plane-scheduled-assign.ts";
import { queueReconnectSession } from "./control-plane-reconnect-session.ts";
import { releaseLegacyHostAssignmentAfterDurableTransition } from "./control-plane-legacy-host-assignment.ts";
import {
  providerAccountLeaseWriteOpts,
  releaseProviderAccountLease,
} from "./control-plane-provider-account-leases.ts";

export async function disconnectScheduledMainCheckouts(
  state: ControlPlaneState,
  hostId: string,
  connectionId: string,
  reason: string,
  requeued: string[],
): Promise<void> {
  const storage = state.storage!;
  const sessions =
    typeof (storage as { listSessionsByHost?: unknown }).listSessionsByHost === "function"
      ? await storage.listSessionsByHost(hostId)
      : [...state.sessions.values()].filter((session) => session.hostId === hostId);
  for (const session of sessions) {
    if (
      !session.mainCheckoutLease ||
      session.status !== "running" ||
      !session.assignmentConnectionId
    )
      continue;
    if (!session.ackReceivedAt) {
      const released = await state.storage!.releaseMainCheckoutSession({
        sessionId: session.id,
        hostId,
        repositoryId: session.repositoryId,
        connectionId,
        status: "queued",
        queueShard: session.queueShard,
        reason,
        ...providerAccountLeaseWriteOpts(session),
      });
      if (released) {
        await releaseLegacyHostAssignmentAfterDurableTransition(state, session);
        releaseScheduledLeaseLocal(state, session);
        releaseProviderAccountLease(state, session);
        state.sessions.set(session.id, queueReconnectSession(session, reason));
        state.pendingAcks.delete(session.id);
        requeued.push(session.id);
      }
      continue;
    }
    const deadlineAt = new Date(Date.parse(state.now()) + state.reconnectGraceMs).toISOString();
    if (
      await state.storage!.markMainCheckoutReconnectPending({
        sessionId: session.id,
        hostId,
        repositoryId: session.repositoryId,
        connectionId,
        deadlineAt,
      })
    )
      state.sessions.set(session.id, { ...session, reconnectDeadlineAt: deadlineAt });
  }
}
