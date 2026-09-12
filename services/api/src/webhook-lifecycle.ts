import { isTerminalSessionStatus } from "@auto-harness/shared";

import type { SessionRecord } from "./db/types.ts";
import type {
  WebhookDestinationSelector,
  WebhookLifecycleSnapshot,
  WebhookOutboxStore,
} from "./webhook-delivery-types.ts";

export function webhookLifecycleSnapshot(session: SessionRecord): WebhookLifecycleSnapshot | null {
  if (!isTerminalSessionStatus(session.status) || !session.completedAt) return null;
  return {
    sessionId: session.id,
    repositoryId: session.repositoryId || null,
    workspacePoolId: session.workspacePoolId ?? null,
    // Terminal transitions release the live slot, while resolvedRoute retains
    // the placement that actually ran the attempt.
    workspaceSlotId: session.resolvedRoute?.workspaceSlotId ?? session.workspaceSlotId ?? null,
    attemptId: session.attemptId ?? null,
    status: session.status,
    occurredAt: session.completedAt,
  };
}

/** Replaying a terminal snapshot is safe because each destination uses a stable insert-only ID. */
export async function reconcileWebhookSession(input: {
  store: WebhookOutboxStore;
  selectDestinations: WebhookDestinationSelector;
  session: SessionRecord;
}): Promise<{ created: number; existing: number }> {
  const snapshot = webhookLifecycleSnapshot(input.session);
  if (!snapshot) return { created: 0, existing: 0 };
  let created = 0;
  let existing = 0;
  for (const destination of await input.selectDestinations(snapshot)) {
    const result = await input.store.enqueueWebhookDelivery({
      sessionId: snapshot.sessionId,
      repositoryId: snapshot.repositoryId,
      workspacePoolId: snapshot.workspacePoolId,
      workspaceSlotId: snapshot.workspaceSlotId,
      attemptId: snapshot.attemptId,
      status: snapshot.status,
      occurredAt: snapshot.occurredAt,
      destination,
    });
    if (result.created) created += 1;
    else existing += 1;
  }
  return { created, existing };
}
