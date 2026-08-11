import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";

import type { AuthAccountRecord, PlaneStorageCtx } from "./plane-storage-types.ts";

export async function putAuthAccount(ctx: PlaneStorageCtx, rec: AuthAccountRecord): Promise<void> {
  await ctx.doc.send(
    new PutCommand({
      TableName: ctx.tables.users,
      Item: { ...rec },
      ConditionExpression: "attribute_not_exists(id)",
    }),
  );
}

export async function getAuthAccount(
  ctx: PlaneStorageCtx,
  id: string,
): Promise<AuthAccountRecord | null> {
  const res = await ctx.doc.send(new GetCommand({ TableName: ctx.tables.users, Key: { id } }));
  return (res.Item as AuthAccountRecord | undefined) ?? null;
}

export async function getAuthAccountByUsername(
  ctx: PlaneStorageCtx,
  username: string,
): Promise<AuthAccountRecord | null> {
  let startKey: Record<string, unknown> | undefined;
  do {
    const res = await ctx.doc.send(
      new QueryCommand({
        TableName: ctx.tables.users,
        IndexName: "username",
        KeyConditionExpression: "username = :u",
        FilterExpression: "#kind = :kind",
        ExpressionAttributeNames: { "#kind": "kind" },
        ExpressionAttributeValues: { ":u": username, ":kind": "user" },
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }),
    );
    const user = res.Items?.[0] as AuthAccountRecord | undefined;
    if (user) return user;
    startKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (startKey && Object.keys(startKey).length > 0);
  return null;
}

export async function listAuthAccounts(ctx: PlaneStorageCtx): Promise<AuthAccountRecord[]> {
  const records: AuthAccountRecord[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const res = await ctx.doc.send(
      new ScanCommand({
        TableName: ctx.tables.users,
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }),
    );
    records.push(...((res.Items ?? []) as AuthAccountRecord[]));
    startKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (startKey && Object.keys(startKey).length > 0);
  return records;
}

export async function deleteAuthAccount(ctx: PlaneStorageCtx, id: string): Promise<void> {
  await ctx.doc.send(new DeleteCommand({ TableName: ctx.tables.users, Key: { id } }));
}
