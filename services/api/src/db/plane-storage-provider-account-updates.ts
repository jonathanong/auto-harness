import { TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  DEFAULT_MAX_CONCURRENT_SESSIONS,
  MAX_CONCURRENT_SESSIONS_LIMIT,
  providerAccountLeaseConcurrencyId,
} from "@auto-harness/shared";

import type { PlaneStorageCtx, ProviderAccountRecord } from "./plane-storage-types.ts";
import { ensureProviderAccountCount } from "./plane-storage-provider-accounts.ts";

export async function updateProviderAccount(
  ctx: PlaneStorageCtx,
  opts: {
    id: string;
    expectedVersion: number;
    expectedProviderId?: string;
    expectedMaxConcurrentSessions?: number;
    updatedAt: string;
    patch: Partial<
      Pick<
        ProviderAccountRecord,
        | "providerId"
        | "label"
        | "usageLimitCooldownSeconds"
        | "usageLimitedUntil"
        | "maxConcurrentSessions"
      >
    >;
  },
): Promise<boolean> {
  const sets: string[] = ["updatedAt = :updatedAt", "version = :nextVersion"];
  const values: Record<string, unknown> = {
    ":expectedVersion": opts.expectedVersion,
    ":nextVersion": opts.expectedVersion + 1,
    ":updatedAt": opts.updatedAt,
  };
  if (opts.patch.providerId !== undefined) {
    sets.push("providerId = :providerId");
    values[":providerId"] = opts.patch.providerId;
  }
  if (opts.patch.label !== undefined) {
    sets.push("label = :label");
    values[":label"] = opts.patch.label;
  }
  if (opts.patch.usageLimitCooldownSeconds !== undefined) {
    sets.push("usageLimitCooldownSeconds = :usageLimitCooldownSeconds");
    values[":usageLimitCooldownSeconds"] = opts.patch.usageLimitCooldownSeconds;
  }
  if (opts.patch.usageLimitedUntil !== undefined) {
    sets.push("usageLimitedUntil = :usageLimitedUntil");
    values[":usageLimitedUntil"] = opts.patch.usageLimitedUntil;
  }
  if (opts.patch.maxConcurrentSessions !== undefined) {
    sets.push("maxConcurrentSessions = :maxConcurrentSessions");
    values[":maxConcurrentSessions"] = opts.patch.maxConcurrentSessions;
  }
  const common = {
    id: opts.id,
    expectedVersion: opts.expectedVersion,
    expression: `SET ${sets.join(", ")}`,
    values,
  };
  const oldCap = opts.expectedMaxConcurrentSessions ?? DEFAULT_MAX_CONCURRENT_SESSIONS;
  const newCap = opts.patch.maxConcurrentSessions;
  const leaseFences =
    newCap !== undefined && newCap < oldCap
      ? providerAccountLeaseFenceItems(ctx, opts.id, newCap)
      : [];
  if (opts.patch.providerId && opts.patch.providerId !== opts.expectedProviderId) {
    if (!(await ensureProviderAccountCount(ctx, opts.expectedProviderId ?? ""))) return false;
    if (!(await ensureProviderAccountCount(ctx, opts.patch.providerId))) return false;
    return moveProviderAccount(ctx, {
      ...common,
      oldProviderId: opts.expectedProviderId,
      newProviderId: opts.patch.providerId,
      leaseFences,
    });
  }
  if (leaseFences.length > 0) return updateWithLeaseFences(ctx, common, leaseFences);
  return update(ctx, common);
}

function providerAccountLeaseFenceItems(
  ctx: PlaneStorageCtx,
  providerAccountId: string,
  newCap: number,
) {
  return Array.from({ length: MAX_CONCURRENT_SESSIONS_LIMIT - newCap }, (_, index) => ({
    ConditionCheck: {
      TableName: ctx.tables.concurrencyLocks,
      Key: { concurrencyId: providerAccountLeaseConcurrencyId(providerAccountId, newCap + index) },
      ConditionExpression: "attribute_not_exists(concurrencyId)",
    },
  }));
}

export async function clearProviderAccountUsageLimit(
  ctx: PlaneStorageCtx,
  opts: {
    id: string;
    expectedVersion: number;
    expectedUsageLimitedUntil?: string | null;
    updatedAt: string;
  },
): Promise<boolean> {
  const expectedCooldown = opts.expectedUsageLimitedUntil;
  const cooldownCondition =
    expectedCooldown === undefined
      ? "attribute_not_exists(usageLimitedUntil)"
      : "usageLimitedUntil = :expectedUsageLimitedUntil";
  return update(ctx, {
    id: opts.id,
    expectedVersion: opts.expectedVersion,
    expression:
      "SET usageLimitedUntil = :usageLimitedUntil, updatedAt = :updatedAt, version = :nextVersion",
    condition: cooldownCondition,
    values: {
      ":updatedAt": opts.updatedAt,
      ":usageLimitedUntil": null,
      ...(expectedCooldown !== undefined ? { ":expectedUsageLimitedUntil": expectedCooldown } : {}),
    },
  });
}

async function update(
  ctx: PlaneStorageCtx,
  opts: {
    id: string;
    expectedVersion: number;
    expression: string;
    condition?: string;
    values: Record<string, unknown>;
  },
): Promise<boolean> {
  try {
    await ctx.doc.send(
      new UpdateCommand({
        TableName: ctx.tables.providerAccounts,
        Key: { id: opts.id },
        UpdateExpression: opts.expression,
        ConditionExpression: [
          "attribute_exists(id)",
          versionCondition(opts.expectedVersion),
          opts.condition,
        ]
          .filter(Boolean)
          .join(" AND "),
        ExpressionAttributeValues: {
          ...opts.values,
          ":expectedVersion": opts.expectedVersion,
          ":nextVersion": opts.expectedVersion + 1,
        },
      }),
    );
    return true;
  } catch (err) {
    if (isConditionalFailure(err)) return false;
    throw err;
  }
}

async function updateWithLeaseFences(
  ctx: PlaneStorageCtx,
  opts: {
    id: string;
    expectedVersion: number;
    expression: string;
    values: Record<string, unknown>;
  },
  leaseFences: Array<{ ConditionCheck: Record<string, unknown> }>,
): Promise<boolean> {
  try {
    await ctx.doc.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: ctx.tables.providerAccounts,
              Key: { id: opts.id },
              UpdateExpression: opts.expression,
              ConditionExpression: `attribute_exists(id) AND ${versionCondition(opts.expectedVersion)}`,
              ExpressionAttributeValues: {
                ...opts.values,
                ":expectedVersion": opts.expectedVersion,
                ":nextVersion": opts.expectedVersion + 1,
              },
            },
          },
          ...leaseFences,
        ],
      }),
    );
    return true;
  } catch (err) {
    if (isConditionalFailure(err)) return false;
    throw err;
  }
}

async function moveProviderAccount(
  ctx: PlaneStorageCtx,
  opts: {
    id: string;
    expectedVersion: number;
    oldProviderId: string | undefined;
    newProviderId: string;
    leaseFences: Array<{ ConditionCheck: Record<string, unknown> }>;
    expression: string;
    values: Record<string, unknown>;
  },
): Promise<boolean> {
  if (!opts.oldProviderId) return false;
  try {
    await ctx.doc.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: ctx.tables.providerAccounts,
              Key: { id: opts.id },
              UpdateExpression: opts.expression,
              ConditionExpression: `providerId = :oldProviderId AND ${versionCondition(opts.expectedVersion)}`,
              ExpressionAttributeValues: {
                ...opts.values,
                ":oldProviderId": opts.oldProviderId,
                ":expectedVersion": opts.expectedVersion,
                ":nextVersion": opts.expectedVersion + 1,
              },
            },
          },
          ...[opts.oldProviderId, opts.newProviderId].map((id, index) => ({
            Update: {
              TableName: ctx.tables.providers,
              Key: { id },
              UpdateExpression: "ADD accountCount :delta",
              ConditionExpression: "attribute_exists(id)",
              ExpressionAttributeValues: { ":delta": index === 0 ? -1 : 1 },
            },
          })),
          ...opts.leaseFences,
        ],
      }),
    );
    return true;
  } catch (err) {
    if (isConditionalFailure(err)) return false;
    throw err;
  }
}

function versionCondition(expectedVersion: number): string {
  return expectedVersion === 0 ? "attribute_not_exists(version)" : "version = :expectedVersion";
}

function isConditionalFailure(err: unknown): boolean {
  if (typeof err !== "object" || err === null || !("name" in err)) return false;
  const named = err as { name?: string; CancellationReasons?: Array<{ Code?: string }> };
  return (
    named.name === "ConditionalCheckFailedException" ||
    (named.name === "TransactionCanceledException" &&
      (named.CancellationReasons?.some((reason) => reason.Code === "ConditionalCheckFailed") ??
        false))
  );
}
