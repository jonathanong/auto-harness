import { DEFAULT_MAX_CONCURRENT_SESSIONS } from "@auto-harness/shared";

import type { PlaneStorageCtx } from "./plane-storage-types.ts";

export function providerAccountLastAssignedTransactItem(
  ctx: PlaneStorageCtx,
  opts: { providerAccountId: string; now: string; slot?: number },
): {
  Update: {
    TableName: string;
    Key: { id: string };
    UpdateExpression: string;
    ConditionExpression: string;
    ExpressionAttributeValues: Record<string, unknown>;
  };
} {
  const values: Record<string, unknown> = { ":now": opts.now, ":nullType": "NULL" };
  let condition =
    "attribute_exists(id) AND (attribute_not_exists(usageLimitedUntil) OR attribute_type(usageLimitedUntil, :nullType) OR usageLimitedUntil <= :now)";
  if (opts.slot !== undefined) {
    condition +=
      " AND ((attribute_not_exists(maxConcurrentSessions) AND :slot < :defaultCap) OR maxConcurrentSessions > :slot)";
    values[":slot"] = opts.slot;
    values[":defaultCap"] = DEFAULT_MAX_CONCURRENT_SESSIONS;
  }
  return {
    Update: {
      TableName: ctx.tables.providerAccounts,
      Key: { id: opts.providerAccountId },
      UpdateExpression: "SET lastAssignedAt = :now, updatedAt = :now",
      ConditionExpression: condition,
      ExpressionAttributeValues: values,
    },
  };
}
