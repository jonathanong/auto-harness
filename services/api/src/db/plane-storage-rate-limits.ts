import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

import {
  type RateLimitBucket,
  type RateLimitDecision,
  rateLimitStorageKey,
  windowStartMs,
} from "../rate-limit.ts";
import { isConditionalFailed, type PlaneStorageCtx } from "./plane-storage-types.ts";

export type DurableRateLimitInput = {
  actorKey: string;
  bucket: RateLimitBucket;
  limit: number;
  windowSeconds: number;
  nowMs: number;
};

type Counter = { windowStartMs?: number; count?: number };

/**
 * Atomically consume one fixed-window token. A stale-window reset and the
 * ordinary increment both carry a condition, so independent API workers share
 * one counter without a read/modify/write race. Expiry bounds table storage.
 */
export async function consumeRateLimit(
  ctx: PlaneStorageCtx,
  input: DurableRateLimitInput,
): Promise<RateLimitDecision> {
  const key = rateLimitStorageKey(input.actorKey, input.bucket);
  const start = windowStartMs(input.nowMs, input.windowSeconds);
  const resetAtMs = start + input.windowSeconds * 1000;
  const itemKey = { bucketKey: key };

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const current = (
      await ctx.doc.send(
        new GetCommand({
          TableName: ctx.tables.rateLimits,
          Key: itemKey,
          ConsistentRead: true,
        }),
      )
    ).Item as Counter | undefined;
    const currentStart = current?.windowStartMs;

    // A delayed request from an older window must never reset a counter that a
    // newer request has already advanced.
    if (currentStart !== undefined && currentStart > start) {
      return {
        allowed: false,
        limit: input.limit,
        remaining: 0,
        resetAtMs: currentStart + input.windowSeconds * 1000,
      };
    }

    if (currentStart === start) {
      const count = current?.count ?? 0;
      if (count >= input.limit) {
        return { allowed: false, limit: input.limit, remaining: 0, resetAtMs };
      }
      try {
        const result = await ctx.doc.send(
          new UpdateCommand({
            TableName: ctx.tables.rateLimits,
            Key: itemKey,
            UpdateExpression: "SET #count = #count + :one, #expiresAt = :expiresAt",
            ConditionExpression: "#windowStart = :windowStart AND #count < :limit",
            ExpressionAttributeNames: {
              "#count": "count",
              "#windowStart": "windowStartMs",
              "#expiresAt": "expiresAt",
            },
            ExpressionAttributeValues: {
              ":one": 1,
              ":windowStart": start,
              ":limit": input.limit,
              ":expiresAt": Math.ceil(resetAtMs / 1000) + 60,
            },
            ReturnValues: "ALL_NEW",
          }),
        );
        const nextCount = Number((result.Attributes as Counter | undefined)?.count ?? count + 1);
        return {
          allowed: true,
          limit: input.limit,
          remaining: Math.max(0, input.limit - nextCount),
          resetAtMs,
        };
      } catch (err) {
        if (isConditionalFailed(err)) continue;
        throw err;
      }
    }

    try {
      const condition =
        currentStart === undefined
          ? "attribute_not_exists(#windowStart)"
          : "#windowStart = :oldWindowStart";
      await ctx.doc.send(
        new UpdateCommand({
          TableName: ctx.tables.rateLimits,
          Key: itemKey,
          UpdateExpression:
            "SET #windowStart = :windowStart, #count = :one, #expiresAt = :expiresAt",
          ConditionExpression: condition,
          ExpressionAttributeNames: {
            "#windowStart": "windowStartMs",
            "#count": "count",
            "#expiresAt": "expiresAt",
          },
          ExpressionAttributeValues: {
            ":windowStart": start,
            ":one": 1,
            ":expiresAt": Math.ceil(resetAtMs / 1000) + 60,
            ...(currentStart === undefined ? {} : { ":oldWindowStart": currentStart }),
          },
        }),
      );
      return { allowed: true, limit: input.limit, remaining: input.limit - 1, resetAtMs };
    } catch (err) {
      if (isConditionalFailed(err)) continue;
      throw err;
    }
  }
  throw new Error("rate-limit contention exceeded retry budget");
}
