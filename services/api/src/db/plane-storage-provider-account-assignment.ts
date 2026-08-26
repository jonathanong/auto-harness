import { DEFAULT_MAX_CONCURRENT_SESSIONS } from "@auto-harness/shared";

import type { PlaneStorageCtx } from "./plane-storage-types.ts";

/** Cap-fence fragment shared with backfillProviderAccountLease's legacy migration path. */
export function maxConcurrentSessionsCapFence(slot: number): {
  condition: string;
  values: Record<string, unknown>;
} {
  return {
    condition:
      "(attribute_not_exists(maxConcurrentSessions) AND :slot < :defaultCap) OR maxConcurrentSessions > :slot",
    values: { ":slot": slot, ":defaultCap": DEFAULT_MAX_CONCURRENT_SESSIONS },
  };
}

export function providerAccountLastAssignedTransactItem(
  ctx: PlaneStorageCtx,
  opts: { providerAccountId: string; providerId?: string; now: string; slot?: number },
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
    const fence = maxConcurrentSessionsCapFence(opts.slot);
    condition += ` AND (${fence.condition})`;
    Object.assign(values, fence.values);
  }
  if (opts.providerId !== undefined) {
    condition += " AND providerId = :providerId";
    values[":providerId"] = opts.providerId;
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
