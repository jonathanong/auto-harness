import { TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

import type { PlaneStorageCtx, ProviderAccountRecord } from "./plane-storage-types.ts";
import { ensureProviderAccountCount } from "./plane-storage-provider-accounts.ts";

export async function updateProviderAccount(
  ctx: PlaneStorageCtx,
  opts: {
    id: string;
    expectedVersion: number;
    expectedProviderId?: string;
    updatedAt: string;
    patch: Partial<
      Pick<
        ProviderAccountRecord,
        "providerId" | "label" | "usageLimitCooldownSeconds" | "usageLimitedUntil"
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
  const common = {
    id: opts.id,
    expectedVersion: opts.expectedVersion,
    expression: `SET ${sets.join(", ")}`,
    values,
  };
  if (opts.patch.providerId && opts.patch.providerId !== opts.expectedProviderId) {
    if (!(await ensureProviderAccountCount(ctx, opts.expectedProviderId ?? ""))) return false;
    if (!(await ensureProviderAccountCount(ctx, opts.patch.providerId))) return false;
    return moveProviderAccount(ctx, {
      ...common,
      oldProviderId: opts.expectedProviderId,
      newProviderId: opts.patch.providerId,
    });
  }
  return update(ctx, common);
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

async function moveProviderAccount(
  ctx: PlaneStorageCtx,
  opts: {
    id: string;
    expectedVersion: number;
    oldProviderId: string | undefined;
    newProviderId: string;
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
  return (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    (err as { name?: string }).name === "ConditionalCheckFailedException"
  );
}
