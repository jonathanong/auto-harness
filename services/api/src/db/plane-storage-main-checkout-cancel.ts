import { UpdateCommand } from "@aws-sdk/lib-dynamodb";

import { statusShardAttr } from "./dynamo.ts";
import { isConditionalFailed, type PlaneStorageCtx } from "./plane-storage-types.ts";

/** Mark one exact running main-checkout attempt cancelled without releasing its lease. */
export async function cancelRunningMainCheckoutSession(
  ctx: PlaneStorageCtx,
  opts: {
    sessionId: string;
    hostId: string;
    connectionId: string;
    attemptId: string;
    queueShard: number;
    completedAt: string;
    deadlineAt: string;
    errorMessage: string;
  },
): Promise<boolean> {
  try {
    await ctx.doc.send(
      new UpdateCommand({
        TableName: ctx.tables.sessions,
        Key: { id: opts.sessionId },
        UpdateExpression:
          "SET #s = :cancelled, statusShard = :statusShard, completedAt = :completedAt, reconnectDeadlineAt = :deadlineAt, errorMessage = :errorMessage",
        ConditionExpression:
          "#s = :running AND hostId = :hostId AND assignmentConnectionId = :connectionId AND attemptId = :attemptId AND worktreeId = :null AND mainCheckoutLease = :true",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":cancelled": "cancelled",
          ":running": "running",
          ":statusShard": statusShardAttr("cancelled", opts.queueShard),
          ":completedAt": opts.completedAt,
          ":deadlineAt": opts.deadlineAt,
          ":errorMessage": opts.errorMessage,
          ":hostId": opts.hostId,
          ":connectionId": opts.connectionId,
          ":attemptId": opts.attemptId,
          ":null": null,
          ":true": true,
        },
      }),
    );
    return true;
  } catch (error) {
    if (isConditionalFailed(error)) return false;
    throw error;
  }
}
