import { GetCommand, ScanCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";

import type { PlaneStorageCtx, ProviderAccountRecord } from "./plane-storage-types.ts";

export async function putProviderAccount(
  ctx: PlaneStorageCtx,
  rec: ProviderAccountRecord,
): Promise<boolean> {
  try {
    await ctx.doc.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: ctx.tables.providerAccounts,
              Item: { ...rec, version: rec.version ?? 1 },
              ConditionExpression: "attribute_not_exists(id)",
            },
          },
          {
            Update: {
              TableName: ctx.tables.providers,
              Key: { id: rec.providerId },
              UpdateExpression: "ADD accountCount :one",
              ConditionExpression: "attribute_exists(id)",
              ExpressionAttributeValues: { ":one": 1 },
            },
          },
        ],
      }),
    );
    return true;
  } catch (err) {
    if (isConditionalFailure(err)) return false;
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
  return normalize(res.Item as ProviderAccountRecord | undefined);
}

export async function listProviderAccounts(ctx: PlaneStorageCtx): Promise<ProviderAccountRecord[]> {
  const records: ProviderAccountRecord[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const res = await ctx.doc.send(
      new ScanCommand({
        TableName: ctx.tables.providerAccounts,
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }),
    );
    records.push(
      ...((res.Items ?? []) as ProviderAccountRecord[]).map((record) => normalize(record)!),
    );
    startKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (startKey && Object.keys(startKey).length > 0);
  return records;
}

export async function deleteProviderAccount(ctx: PlaneStorageCtx, id: string): Promise<boolean> {
  const account = await getProviderAccount(ctx, id);
  if (!account) return false;
  try {
    await ctx.doc.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Delete: {
              TableName: ctx.tables.providerAccounts,
              Key: { id },
              ConditionExpression: "providerId = :providerId AND version = :version",
              ExpressionAttributeValues: {
                ":providerId": account.providerId,
                ":version": account.version,
              },
            },
          },
          {
            Update: {
              TableName: ctx.tables.providers,
              Key: { id: account.providerId },
              UpdateExpression: "ADD accountCount :minusOne",
              ConditionExpression: "attribute_exists(id)",
              ExpressionAttributeValues: { ":minusOne": -1 },
            },
          },
        ],
      }),
    );
    return true;
  } catch (err) {
    if (isConditionalFailure(err)) return false;
    throw err;
  }
}

function normalize(record: ProviderAccountRecord | undefined): ProviderAccountRecord | null {
  return record ? { ...record, version: record.version ?? 0 } : null;
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
