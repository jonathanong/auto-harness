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
      await storage.clearPendingCancelRedelivery(candidate.sessionId);
      continue;
    }
    if (candidate.attempts >= MAX_CANCEL_REDELIVERY_ATTEMPTS) {
      await storage.clearPendingCancelRedelivery(candidate.sessionId);
      continue;
    }
    state.onHostMessage?.(candidate.hostId, {
      type: "session:cancel",
      sessionId: candidate.sessionId,
      attemptId: candidate.attemptId,
    });
    await storage.recordCancelRedeliveryAttempt(candidate.sessionId, state.now());
    redelivered += 1;
  }
  return redelivered;
}
