import type { TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";

import type { PlaneStorageCtx } from "./plane-storage-types.ts";
import type { SessionRecord } from "./types.ts";

export const SESSION_DELETION_FENCE_SCOPE = "__retention#v1#deleted";

export function sessionRetentionAdmissionCheck(
  ctx: PlaneStorageCtx,
  sessionId: string,
): NonNullable<TransactWriteCommandInput["TransactItems"]>[number] {
  return {
    ConditionCheck: {
      TableName: ctx.tables.sessionDrains,
      Key: { scopeKey: SESSION_DELETION_FENCE_SCOPE, recordKey: sessionId },
      ConditionExpression: "attribute_not_exists(scopeKey)",
    },
  };
}

export function sessionRetentionEligible(session: SessionRecord): boolean {
  return (
    ["completed", "failed", "cancelled", "timed_out"].includes(session.status) &&
    Number.isFinite(Date.parse(session.completedAt ?? "")) &&
    !session.worktreeId &&
    !session.workspaceSlotId &&
    !session.mainCheckoutLease &&
    !session.workspaceSlotLease &&
    !session.providerAccountLease &&
    !session.hostAssignmentLease &&
    !session.activeHostId &&
    !session.reconnectDeadlineAt &&
    !session.terminalHookHandoff &&
    !(
      session.errorCode === "checkout_fetch_failed" &&
      (session.terminalHookHandoffSettled || session.terminalHookHandoffExpiredAt) &&
      !session.terminalHookLifecycleEnqueuedAt
    )
  );
}
