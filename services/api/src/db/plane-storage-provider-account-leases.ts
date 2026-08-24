import { DeleteCommand } from "@aws-sdk/lib-dynamodb";

import { isConditionalFailed, type PlaneStorageCtx } from "./plane-storage-types.ts";

export type ProviderAccountLeaseKey = {
  concurrencyId: string;
  attemptId: string;
  providerAccountId: string;
  slot: number;
};

/** Attempt-owned lock delete; missing rows succeed so a retry cannot stick the slot. */
function providerAccountLeaseDeleteItem(
  tableName: string,
  opts: { concurrencyId: string; sessionId: string; attemptId: string },
) {
  return {
    Delete: {
      TableName: tableName,
      Key: { concurrencyId: opts.concurrencyId },
      ConditionExpression:
        "attribute_not_exists(concurrencyId) OR (sessionId = :sessionId AND attemptId = :attemptId)",
      ExpressionAttributeValues: {
        ":sessionId": opts.sessionId,
        ":attemptId": opts.attemptId,
      },
    },
  };
}

export function providerAccountLeaseDeleteItems(
  tableName: string,
  sessionId: string,
  lease: ProviderAccountLeaseKey | undefined,
) {
  return lease
    ? [
        providerAccountLeaseDeleteItem(tableName, {
          concurrencyId: lease.concurrencyId,
          sessionId,
          attemptId: lease.attemptId,
        }),
      ]
    : [];
}

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
        ConditionExpression:
          "attribute_not_exists(concurrencyId) OR (sessionId = :sessionId AND attemptId = :attemptId)",
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
