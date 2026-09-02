import type { ControlPlaneState } from "./control-plane-state.ts";

/**
 * Operator-initiated `session:cancel` is a best-effort WebSocket push with no
 * ack. `handleCancel` on the host daemon is idempotent, so redelivering it is
 * safe; this bounds how many cron ticks we keep retrying before giving up and
 * relying on `reconcileHostRunningSessions` to catch a stale session at the
 * host's next `host:register`.
 */
export const MAX_CANCEL_REDELIVERY_ATTEMPTS = 3;

/** Durable redelivery for operator-initiated `session:cancel`. */
export async function redeliverPendingCancels(
  state: ControlPlaneState,
  limit = 25,
  shouldContinue: () => boolean = () => true,
): Promise<number> {
  const storage = state.storage;
  if (!storage) return 0;
  const candidates = await storage.listPendingCancelRedeliveries(limit);
  let redelivered = 0;
  for (const candidate of candidates) {
    if (!shouldContinue()) break;
    const hostLock = await storage.getHostLock(candidate.hostId);
    if (hostLock === null) {
      // The host has no live connection right now, so there is nowhere to push
      // the cancel. Leave the marker pending rather than clearing it: on
      // reconnect, `reconcileHostRunningSessions` silently drops a stale
      // reported session (it isn't "running" anymore) without telling the
      // daemon to stop it, so this outbox is the only thing that will ever
      // redeliver the cancel to that host once it reconnects. Bump it to the
      // back of the queue so a run of disconnected hosts can't permanently
      // occupy every oldest-page query and starve a newer, deliverable
      // candidate — see `deferPendingCancelRedelivery`.
      await storage.deferPendingCancelRedelivery(candidate.sessionId, state.now());
      continue;
    }
    const claimed = await storage.claimCancelRedeliveryAttempt(
      candidate.sessionId,
      state.now(),
      MAX_CANCEL_REDELIVERY_ATTEMPTS,
    );
    if (!claimed) {
      await storage.clearPendingCancelRedelivery(candidate.sessionId);
      continue;
    }
    state.onHostMessage?.(candidate.hostId, {
      type: "session:cancel",
      sessionId: candidate.sessionId,
      attemptId: candidate.attemptId,
    });
    redelivered += 1;
  }
  return redelivered;
}
