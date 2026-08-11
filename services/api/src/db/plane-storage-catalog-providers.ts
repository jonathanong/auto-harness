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
import {
  guardedWrite,
  ownedDelete,
  type DeletionMarker,
  type OwnedDeletionMarker,
} from "./plane-storage-deletion-markers.ts";

export async function putProvider(
  ctx: PlaneStorageCtx,
  rec: ProviderRecord,
  markers?: readonly DeletionMarker[],
): Promise<void> {
  // Older callers constructed provider records before timestamps became
  // mandatory. The document client drops undefined expression values, so
  // include timestamp clauses only when the caller supplied them.
  const timestampUpdates: string[] = [];
  const values: Record<string, unknown> = {
    ":name": rec.name,
    ":zero": 0,
  };
  if (rec.defaultCommandId !== undefined) {
    timestampUpdates.push("defaultCommandId = :defaultCommandId");
    values[":defaultCommandId"] = rec.defaultCommandId;
  }
  if (rec.createdAt !== undefined) {
    timestampUpdates.push("createdAt = if_not_exists(createdAt, :createdAt)");
    values[":createdAt"] = rec.createdAt;
  }
  if (rec.updatedAt !== undefined) {
    timestampUpdates.push("updatedAt = :updatedAt");
    values[":updatedAt"] = rec.updatedAt;
  }
  const update = {
    TableName: ctx.tables.providers,
    Key: { id: rec.id },
    UpdateExpression: `SET #name = :name, accountCount = if_not_exists(accountCount, :zero)${timestampUpdates.length ? `, ${timestampUpdates.join(", ")}` : ""}`,
    ExpressionAttributeNames: { "#name": "name" },
    ExpressionAttributeValues: values,
  };
  await guardedWrite(ctx, markers, { Update: update }, async () => {
    await ctx.doc.send(new UpdateCommand(update));
  });
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
        ConsistentRead: true,
        TableName: ctx.tables.providers,
        ConsistentRead: true,
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }),
    );
    records.push(...((res.Items ?? []) as ProviderRecord[]));
    startKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (startKey && Object.keys(startKey).length > 0);
  return records;
}

export async function deleteProvider(
  ctx: PlaneStorageCtx,
  id: string,
  markers?: readonly OwnedDeletionMarker[],
): Promise<boolean> {
  if (!(await ensureProviderAccountCount(ctx, id))) return false;
  try {
    const deletion = {
      TableName: ctx.tables.providers,
      Key: { id },
      ConditionExpression: "attribute_not_exists(accountCount) OR accountCount = :zero",
      ExpressionAttributeValues: { ":zero": 0 },
    };
    if (markers?.length) await ownedDelete(ctx, markers, { Delete: deletion });
    else await ctx.doc.send(new DeleteCommand(deletion));
    return true;
  } catch (err) {
    if (isConditionalFailed(err)) return false;
    throw err;
  }
}

export async function putCommand(
  ctx: PlaneStorageCtx,
  rec: CommandRecord,
  markers?: readonly DeletionMarker[],
): Promise<void> {
  const write = { Put: { TableName: ctx.tables.commands, Item: { ...rec } } };
  await guardedWrite(ctx, markers, write, async () => {
    await ctx.doc.send(new PutCommand(write.Put));
  });
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
        ConsistentRead: true,
        TableName: ctx.tables.commands,
        ConsistentRead: true,
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }),
    );
    records.push(...((res.Items ?? []) as CommandRecord[]));
    startKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (startKey && Object.keys(startKey).length > 0);
  return records;
}

export async function deleteCommand(
  ctx: PlaneStorageCtx,
  id: string,
  markers?: readonly OwnedDeletionMarker[],
): Promise<void> {
  const write = { Delete: { TableName: ctx.tables.commands, Key: { id } } };
  if (markers?.length) return ownedDelete(ctx, markers, write);
  await ctx.doc.send(new DeleteCommand(write.Delete));
}
