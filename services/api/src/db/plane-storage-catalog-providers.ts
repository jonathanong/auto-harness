import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

import {
  isConditionalFailed,
  type CommandRecord,
  type PlaneStorageCtx,
  type ProviderRecord,
} from "./plane-storage-types.ts";
import { ensureProviderAccountCount } from "./plane-storage-provider-accounts.ts";

export async function putProvider(ctx: PlaneStorageCtx, rec: ProviderRecord): Promise<void> {
  await ctx.doc.send(
    new UpdateCommand({
      TableName: ctx.tables.providers,
      Key: { id: rec.id },
      UpdateExpression:
        "SET #name = :name, defaultCommandId = :defaultCommandId, createdAt = if_not_exists(createdAt, :createdAt), updatedAt = :updatedAt, accountCount = if_not_exists(accountCount, :zero)",
      ExpressionAttributeNames: { "#name": "name" },
      ExpressionAttributeValues: {
        ":name": rec.name,
        ":defaultCommandId": rec.defaultCommandId,
        ":createdAt": rec.createdAt,
        ":updatedAt": rec.updatedAt,
        ":zero": 0,
      },
    }),
  );
}

export async function getProvider(
  ctx: PlaneStorageCtx,
  id: string,
): Promise<ProviderRecord | null> {
  const res = await ctx.doc.send(new GetCommand({ TableName: ctx.tables.providers, Key: { id } }));
  return (res.Item as ProviderRecord | undefined) ?? null;
}

export async function listProviders(ctx: PlaneStorageCtx): Promise<ProviderRecord[]> {
  const records: ProviderRecord[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const res = await ctx.doc.send(
      new ScanCommand({
        TableName: ctx.tables.providers,
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }),
    );
    records.push(...((res.Items ?? []) as ProviderRecord[]));
    startKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (startKey && Object.keys(startKey).length > 0);
  return records;
}

export async function deleteProvider(ctx: PlaneStorageCtx, id: string): Promise<boolean> {
  if (!(await ensureProviderAccountCount(ctx, id))) return false;
  try {
    await ctx.doc.send(
      new DeleteCommand({
        TableName: ctx.tables.providers,
        Key: { id },
        ConditionExpression: "attribute_not_exists(accountCount) OR accountCount = :zero",
        ExpressionAttributeValues: { ":zero": 0 },
      }),
    );
    return true;
  } catch (err) {
    if (isConditionalFailed(err)) return false;
    throw err;
  }
}

export async function putCommand(ctx: PlaneStorageCtx, rec: CommandRecord): Promise<void> {
  await ctx.doc.send(new PutCommand({ TableName: ctx.tables.commands, Item: { ...rec } }));
}

export async function getCommand(ctx: PlaneStorageCtx, id: string): Promise<CommandRecord | null> {
  const res = await ctx.doc.send(new GetCommand({ TableName: ctx.tables.commands, Key: { id } }));
  return (res.Item as CommandRecord | undefined) ?? null;
}

export async function listCommands(ctx: PlaneStorageCtx): Promise<CommandRecord[]> {
  const records: CommandRecord[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const res = await ctx.doc.send(
      new ScanCommand({
        TableName: ctx.tables.commands,
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }),
    );
    records.push(...((res.Items ?? []) as CommandRecord[]));
    startKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (startKey && Object.keys(startKey).length > 0);
  return records;
}

export async function deleteCommand(ctx: PlaneStorageCtx, id: string): Promise<void> {
  await ctx.doc.send(new DeleteCommand({ TableName: ctx.tables.commands, Key: { id } }));
}
