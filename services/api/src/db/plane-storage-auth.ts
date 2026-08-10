import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
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

/** Replace only a user password hash; do not recreate an account after deletion. */
export async function updateAuthAccountPassword(
  ctx: PlaneStorageCtx,
  id: string,
  expectedPasswordHash: string,
  passwordHash: string,
  updatedAt: string,
): Promise<boolean> {
  try {
    await ctx.doc.send(
      new UpdateCommand({
        TableName: ctx.tables.users,
        Key: { id },
        UpdateExpression: "SET passwordHash = :passwordHash, updatedAt = :updatedAt",
        ConditionExpression:
          "attribute_exists(id) AND #kind = :kind AND passwordHash = :expectedPasswordHash",
        ExpressionAttributeNames: { "#kind": "kind" },
        ExpressionAttributeValues: {
          ":passwordHash": passwordHash,
          ":expectedPasswordHash": expectedPasswordHash,
          ":updatedAt": updatedAt,
          ":kind": "user",
        },
      }),
    );
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "name" in error) {
      if ((error as { name?: unknown }).name === "ConditionalCheckFailedException") return false;
    }
    throw error;
  }
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
  } while (startKey);
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
  } while (startKey);
  return records;
}

export async function deleteAuthAccount(ctx: PlaneStorageCtx, id: string): Promise<void> {
  await ctx.doc.send(new DeleteCommand({ TableName: ctx.tables.users, Key: { id } }));
}
