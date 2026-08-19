import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

import type {
  CommandRecord,
  PlaneStorageCtx,
  ProviderAccountRecord,
  ProviderRecord,
} from "./plane-storage-types.ts";

export async function putProvider(ctx: PlaneStorageCtx, rec: ProviderRecord): Promise<void> {
  await ctx.doc.send(new PutCommand({ TableName: ctx.tables.providers, Item: { ...rec } }));
}

export async function getProvider(
  ctx: PlaneStorageCtx,
  id: string,
): Promise<ProviderRecord | null> {
  const res = await ctx.doc.send(new GetCommand({ TableName: ctx.tables.providers, Key: { id } }));
  return (res.Item as ProviderRecord | undefined) ?? null;
}

export async function listProviders(ctx: PlaneStorageCtx): Promise<ProviderRecord[]> {
  const res = await ctx.doc.send(new ScanCommand({ TableName: ctx.tables.providers }));
  return (res.Items ?? []) as ProviderRecord[];
}

export async function deleteProvider(ctx: PlaneStorageCtx, id: string): Promise<void> {
  await ctx.doc.send(new DeleteCommand({ TableName: ctx.tables.providers, Key: { id } }));
}

export async function putProviderAccount(
  ctx: PlaneStorageCtx,
  rec: ProviderAccountRecord,
): Promise<void> {
  const item: Record<string, unknown> = { ...rec };
  for (const key of ["usageLimitedUntil", "lastUsageLimitedAt", "lastAssignedAt"] as const) {
    if (item[key] == null) delete item[key];
  }
  await ctx.doc.send(new PutCommand({ TableName: ctx.tables.providerAccounts, Item: item }));
}

/**
 * Update only the mutable catalog fields observed by a control-plane process.
 * The updatedAt compare-and-swap prevents an older hydrated record from
 * overwriting a cooldown (or recreating an account deleted by another
 * process).  Creation remains an unconditional put; updates must use this
 * method.
 */
export async function updateProviderAccount(
  ctx: PlaneStorageCtx,
  opts: {
    id: string;
    expectedUpdatedAt: string;
    updatedAt: string;
    patch: Partial<
      Pick<
        ProviderAccountRecord,
        "providerId" | "label" | "usageLimitCooldownSeconds" | "usageLimitedUntil"
      >
    >;
  },
): Promise<boolean> {
  const sets: string[] = ["updatedAt = :updatedAt"];
  const removes: string[] = [];
  const values: Record<string, unknown> = {
    ":expectedUpdatedAt": opts.expectedUpdatedAt,
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
    if (opts.patch.usageLimitedUntil === null) {
      removes.push("usageLimitedUntil");
    } else {
      sets.push("usageLimitedUntil = :usageLimitedUntil");
      values[":usageLimitedUntil"] = opts.patch.usageLimitedUntil;
    }
  }
  try {
    await ctx.doc.send(
      new UpdateCommand({
        TableName: ctx.tables.providerAccounts,
        Key: { id: opts.id },
        UpdateExpression:
          removes.length > 0
            ? `SET ${sets.join(", ")} REMOVE ${removes.join(", ")}`
            : `SET ${sets.join(", ")}`,
        ConditionExpression: "attribute_exists(id) AND updatedAt = :expectedUpdatedAt",
        ExpressionAttributeValues: values,
      }),
    );
    return true;
  } catch (err) {
    if (
      typeof err === "object" &&
      err !== null &&
      "name" in err &&
      (err as { name: string }).name === "ConditionalCheckFailedException"
    ) {
      return false;
    }
    throw err;
  }
}

/** Clear only the cooldown field, guarded by the same account version CAS. */
export async function clearProviderAccountUsageLimit(
  ctx: PlaneStorageCtx,
  opts: {
    id: string;
    expectedUpdatedAt: string;
    expectedUsageLimitedUntil?: string | null;
    updatedAt: string;
  },
): Promise<boolean> {
  const expectedCooldown = opts.expectedUsageLimitedUntil;
  const values: Record<string, unknown> = { ":expectedUpdatedAt": opts.expectedUpdatedAt };
  const cooldownCondition =
    expectedCooldown == null
      ? "(attribute_not_exists(usageLimitedUntil) OR attribute_type(usageLimitedUntil, :nullType))"
      : "usageLimitedUntil = :expectedUsageLimitedUntil";
  if (expectedCooldown !== undefined && expectedCooldown !== null) {
    values[":expectedUsageLimitedUntil"] = expectedCooldown;
  }
  if (expectedCooldown == null) values[":nullType"] = "NULL";
  try {
    await ctx.doc.send(
      new UpdateCommand({
        TableName: ctx.tables.providerAccounts,
        Key: { id: opts.id },
        UpdateExpression: "REMOVE usageLimitedUntil SET updatedAt = :updatedAt",
        ConditionExpression: `attribute_exists(id) AND updatedAt = :expectedUpdatedAt AND ${cooldownCondition}`,
        ExpressionAttributeValues: {
          ...values,
          ":updatedAt": opts.updatedAt,
        },
      }),
    );
    return true;
  } catch (err) {
    if (
      typeof err === "object" &&
      err !== null &&
      "name" in err &&
      (err as { name: string }).name === "ConditionalCheckFailedException"
    ) {
      return false;
    }
    throw err;
  }
}

export async function getProviderAccount(
  ctx: PlaneStorageCtx,
  id: string,
): Promise<ProviderAccountRecord | null> {
  const res = await ctx.doc.send(
    new GetCommand({ TableName: ctx.tables.providerAccounts, Key: { id } }),
  );
  const item = res.Item;
  if (!item) return null;
  return {
    ...(item as ProviderAccountRecord),
    usageLimitedUntil: (item.usageLimitedUntil as string | null | undefined) ?? null,
    lastUsageLimitedAt: (item.lastUsageLimitedAt as string | null | undefined) ?? null,
    lastAssignedAt: (item.lastAssignedAt as string | null | undefined) ?? null,
  };
}

export async function listProviderAccounts(ctx: PlaneStorageCtx): Promise<ProviderAccountRecord[]> {
  const res = await ctx.doc.send(new ScanCommand({ TableName: ctx.tables.providerAccounts }));
  return (res.Items ?? []) as ProviderAccountRecord[];
}

export async function deleteProviderAccount(ctx: PlaneStorageCtx, id: string): Promise<void> {
  await ctx.doc.send(new DeleteCommand({ TableName: ctx.tables.providerAccounts, Key: { id } }));
}

export async function putCommand(ctx: PlaneStorageCtx, rec: CommandRecord): Promise<void> {
  await ctx.doc.send(new PutCommand({ TableName: ctx.tables.commands, Item: { ...rec } }));
}

export async function getCommand(ctx: PlaneStorageCtx, id: string): Promise<CommandRecord | null> {
  const res = await ctx.doc.send(new GetCommand({ TableName: ctx.tables.commands, Key: { id } }));
  return (res.Item as CommandRecord | undefined) ?? null;
}

export async function listCommands(ctx: PlaneStorageCtx): Promise<CommandRecord[]> {
  const res = await ctx.doc.send(new ScanCommand({ TableName: ctx.tables.commands }));
  return (res.Items ?? []) as CommandRecord[];
}

export async function deleteCommand(ctx: PlaneStorageCtx, id: string): Promise<void> {
  await ctx.doc.send(new DeleteCommand({ TableName: ctx.tables.commands, Key: { id } }));
}
