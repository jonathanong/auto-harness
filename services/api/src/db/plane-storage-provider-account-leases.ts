import { DeleteCommand } from "@aws-sdk/lib-dynamodb";

import { isConditionalFailed, type PlaneStorageCtx } from "./plane-storage-types.ts";

/** Delete only the lease owned by this attempt; a later slot owner is untouched. */
export async function releaseProviderAccountLease(
  ctx: PlaneStorageCtx,
  opts: { concurrencyId: string; sessionId: string; attemptId: string },
): Promise<void> {
  try {
    await ctx.doc.send(
      new DeleteCommand({
        TableName: ctx.tables.concurrencyLocks,
        Key: { concurrencyId: opts.concurrencyId },
        ConditionExpression: "sessionId = :sessionId AND attemptId = :attemptId",
        ExpressionAttributeValues: {
          ":sessionId": opts.sessionId,
          ":attemptId": opts.attemptId,
        },
      }),
    );
  } catch (err) {
    if (!isConditionalFailed(err)) throw err;
  }
}
