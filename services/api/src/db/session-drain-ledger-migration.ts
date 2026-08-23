import { sessionPrincipalId } from "../control-plane-session-owner.ts";
import { itemToSession } from "./plane-storage-types.ts";
import { sessionDrainActivityKey, sessionDrainScopeKey } from "./plane-storage-session-drains.ts";

function canStillAffectDrain(session: {
  status: string;
  worktreeId?: string | null;
  mainCheckoutLease?: boolean;
}): boolean {
  return (
    session.status === "queued" ||
    session.status === "running" ||
    (session.status === "cancelled" &&
      (session.worktreeId != null || session.mainCheckoutLease === true))
  );
}

export function sessionDrainLedgerActivityForItem(
  item: Record<string, unknown>,
): Record<string, unknown> | null {
  const session = itemToSession(item);
  const principalId = sessionPrincipalId(session);
  if (!principalId || !canStillAffectDrain(session)) return null;
  return {
    scopeKey: sessionDrainScopeKey(session.repositoryId, principalId),
    recordKey: sessionDrainActivityKey(session.id),
    recordType: "activity",
    sessionId: session.id,
    repositoryId: session.repositoryId,
    principalId,
  };
}
