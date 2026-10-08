import { UpdateCommand } from "@aws-sdk/lib-dynamodb";

import { isConditionalFailed, type PlaneStorageCtx } from "./plane-storage-types.ts";
import type { SessionRecord } from "./types.ts";

/** The stable Slack outbox operation is durable before this recovery marker is set. */
export async function markTerminalHookLifecycleEnqueued(
  ctx: PlaneStorageCtx,
  session: Pick<
    SessionRecord,
    "id" | "createdAt" | "attemptId" | "terminalHookHandoffSettled" | "terminalHookHandoffExpiredAt"
  >,
  at: string,
): Promise<boolean> {
  try {
    await ctx.doc.send(
      new UpdateCommand({
        TableName: ctx.tables.sessions,
        Key: { id: session.id },
        UpdateExpression:
          "SET terminalHookLifecycleEnqueuedAt = if_not_exists(terminalHookLifecycleEnqueuedAt, :at)",
        ConditionExpression:
          "createdAt = :createdAt AND attemptId = :attemptId AND errorCode = :checkout AND attribute_not_exists(terminalHookHandoff) AND (terminalHookHandoffSettled.handoffId = :handoffId OR terminalHookHandoffExpiredAt = :expiredAt)",
        ExpressionAttributeValues: {
          ":at": at,
          ":checkout": "checkout_fetch_failed",
          ":createdAt": session.createdAt,
          ":attemptId": session.attemptId,
          ":handoffId": session.terminalHookHandoffSettled?.handoffId ?? "",
          ":expiredAt": session.terminalHookHandoffExpiredAt ?? "",
        },
      }),
    );
    return true;
  } catch (error) {
    if (!isConditionalFailed(error)) throw error;
    return false;
  }
}
