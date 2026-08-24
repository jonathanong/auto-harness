import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";

import { statusShardAttr } from "./dynamo.ts";
import { isConditionalTransactionFailed, type PlaneStorageCtx } from "./plane-storage-types.ts";
import {
  readSessionDrainActivity,
  sessionDrainActivityDelete,
} from "./plane-storage-session-drain-activity.ts";

/**
 * A resume pin is a deadline, not a scheduling preference. Guard the failure
 * transition with the observed pin value so a concurrent retry/resume cannot
 * be overwritten by a scheduler that hydrated an older queued row.
 */
export async function failExpiredResumeSession(
  ctx: PlaneStorageCtx,
  opts: { sessionId: string; queueShard: number; pinExpiresAt: string; concurrencyId?: string },
): Promise<boolean> {
  const before = await readSessionDrainActivity(ctx, opts.sessionId);
  try {
    await ctx.doc.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: ctx.tables.sessions,
              Key: { id: opts.sessionId },
              UpdateExpression:
                "SET #s = :failed, statusShard = :statusShard, errorCode = :errorCode, errorMessage = :errorMessage",
              ConditionExpression: "#s = :queued AND pinExpiresAt = :pinExpiresAt",
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: {
                ":failed": "failed",
                ":statusShard": statusShardAttr("failed", opts.queueShard),
                ":errorCode": "resume_failed",
                ":errorMessage": "pin expired",
                ":queued": "queued",
                ":pinExpiresAt": opts.pinExpiresAt,
              },
            },
          },
          ...(opts.concurrencyId
            ? [
                {
                  Delete: {
                    TableName: ctx.tables.concurrencyLocks,
                    Key: { concurrencyId: opts.concurrencyId },
                    ConditionExpression:
                      "attribute_not_exists(concurrencyId) OR sessionId = :sessionId",
                    ExpressionAttributeValues: { ":sessionId": opts.sessionId },
                  },
                },
              ]
            : []),
          ...sessionDrainActivityDelete(ctx, before?.activity ?? null),
        ],
      }),
    );
    return true;
  } catch (err) {
    if (isConditionalTransactionFailed(err)) {
      return false;
    }
    throw err;
  }
}
