import { DeleteCommand, GetCommand, PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";

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
  await ctx.doc.send(new PutCommand({ TableName: ctx.tables.providerAccounts, Item: { ...rec } }));
}

export async function getProviderAccount(
  ctx: PlaneStorageCtx,
  id: string,
): Promise<ProviderAccountRecord | null> {
  const res = await ctx.doc.send(
    new GetCommand({ TableName: ctx.tables.providerAccounts, Key: { id } }),
  );
  return (res.Item as ProviderAccountRecord | undefined) ?? null;
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
