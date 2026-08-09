import { DeleteCommand, GetCommand, PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";

import type { AuthAccountRecord, PlaneStorageCtx } from "./plane-storage-types.ts";

export async function putAuthAccount(ctx: PlaneStorageCtx, rec: AuthAccountRecord): Promise<void> {
  await ctx.doc.send(new PutCommand({ TableName: ctx.tables.users, Item: { ...rec } }));
}

export async function getAuthAccount(
  ctx: PlaneStorageCtx,
  id: string,
): Promise<AuthAccountRecord | null> {
  const res = await ctx.doc.send(new GetCommand({ TableName: ctx.tables.users, Key: { id } }));
  return (res.Item as AuthAccountRecord | undefined) ?? null;
}

export async function listAuthAccounts(ctx: PlaneStorageCtx): Promise<AuthAccountRecord[]> {
  const res = await ctx.doc.send(new ScanCommand({ TableName: ctx.tables.users }));
  return (res.Items ?? []) as AuthAccountRecord[];
}

export async function deleteAuthAccount(ctx: PlaneStorageCtx, id: string): Promise<void> {
  await ctx.doc.send(new DeleteCommand({ TableName: ctx.tables.users, Key: { id } }));
}
