import {
  DeleteCommand,
  PutCommand,
  TransactWriteCommand,
  UpdateCommand,
  type TransactWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";

import { isConditionalFailed, type PlaneStorageCtx } from "./plane-storage-types.ts";

const PREFIX = "catalog-delete:";

export type DeletionMarker = { key: string; now: string };
export type OwnedDeletionMarker = DeletionMarker & { owner: string };

export function markerConditions(markers: readonly DeletionMarker[]) {
  return markers.map((marker) => ({
    ConditionCheck: {
      TableName: "__MARKER_TABLE__",
      Key: { concurrencyId: `${PREFIX}${marker.key}` },
      ConditionExpression: "attribute_not_exists(concurrencyId) OR expiresAt <= :now",
      ExpressionAttributeValues: { ":now": marker.now },
    },
  }));
}

export function ownedMarkerConditions(markers: readonly OwnedDeletionMarker[]) {
  return markers.map((marker) => ({
    ConditionCheck: {
      TableName: "__MARKER_TABLE__",
      Key: { concurrencyId: `${PREFIX}${marker.key}` },
      ConditionExpression: "deletionOwner = :owner AND expiresAt > :now",
      ExpressionAttributeValues: { ":owner": marker.owner, ":now": marker.now },
    },
  }));
}

/** A short marker in the existing concurrency-lock namespace serializes catalog removal. */
export async function acquireDeletionMarker(
  ctx: PlaneStorageCtx,
  key: string,
  owner: string,
  now: string,
  leaseMs = 30_000,
): Promise<boolean> {
  const at = Date.parse(now);
  const expiresMs = (Number.isFinite(at) ? at : Date.now()) + leaseMs;
  const expiresAt = new Date(expiresMs).toISOString();
  try {
    await ctx.doc.send(
      new PutCommand({
        TableName: ctx.tables.concurrencyLocks,
        Item: {
          concurrencyId: `${PREFIX}${key}`,
          deletionOwner: owner,
          expiresAt,
          ttl: Math.floor(expiresMs / 1_000),
        },
        ConditionExpression: "attribute_not_exists(concurrencyId) OR expiresAt <= :now",
        ExpressionAttributeValues: { ":now": now },
      }),
    );
    return true;
  } catch (error) {
    if (isConditionalFailed(error)) return false;
    throw error;
  }
}

export async function releaseDeletionMarker(
  ctx: PlaneStorageCtx,
  key: string,
  owner: string,
): Promise<void> {
  try {
    await ctx.doc.send(
      new DeleteCommand({
        TableName: ctx.tables.concurrencyLocks,
        Key: { concurrencyId: `${PREFIX}${key}` },
        ConditionExpression: "deletionOwner = :owner",
        ExpressionAttributeValues: { ":owner": owner },
      }),
    );
  } catch (error) {
    if (!isConditionalFailed(error)) throw error;
  }
}

export async function renewDeletionMarker(
  ctx: PlaneStorageCtx,
  key: string,
  owner: string,
  now: string,
  leaseMs = 30_000,
): Promise<boolean> {
  const parsed = Date.parse(now);
  const expiresMs = (Number.isFinite(parsed) ? parsed : Date.now()) + leaseMs;
  const expiresAt = new Date(expiresMs).toISOString();
  try {
    await ctx.doc.send(
      new UpdateCommand({
        TableName: ctx.tables.concurrencyLocks,
        Key: { concurrencyId: `${PREFIX}${key}` },
        UpdateExpression: "SET expiresAt = :expiresAt, ttl = :ttl",
        ConditionExpression: "deletionOwner = :owner AND expiresAt > :now",
        ExpressionAttributeValues: {
          ":owner": owner,
          ":now": now,
          ":expiresAt": expiresAt,
          ":ttl": Math.floor(expiresMs / 1_000),
        },
      }),
    );
    return true;
  } catch (error) {
    if (isConditionalFailed(error)) return false;
    throw error;
  }
}

/** Replace the symbolic table marker at the storage edge, keeping callers table-agnostic. */
export function withMarkerTable<T extends { ConditionCheck: { TableName: string } }>(
  ctx: PlaneStorageCtx,
  conditions: T[],
): T[] {
  return conditions.map((condition) => ({
    ...condition,
    ConditionCheck: { ...condition.ConditionCheck, TableName: ctx.tables.concurrencyLocks },
  }));
}

type TransactionItem = NonNullable<TransactWriteCommandInput["TransactItems"]>[number];

export async function guardedWrite(
  ctx: PlaneStorageCtx,
  markers: readonly DeletionMarker[] | undefined,
  write: TransactionItem,
  fallback: () => Promise<void>,
): Promise<void> {
  if (!markers?.length) return fallback();
  if (markers.length > 99) {
    throw new Error("catalog reference write exceeds DynamoDB's 100 transaction action limit");
  }
  await ctx.doc.send(
    new TransactWriteCommand({
      TransactItems: [...withMarkerTable(ctx, markerConditions([...markers])), write],
    }),
  );
}

export async function ownedDelete(
  ctx: PlaneStorageCtx,
  markers: readonly OwnedDeletionMarker[],
  write: TransactionItem,
): Promise<void> {
  if (markers.length > 99) {
    throw new Error("catalog delete exceeds DynamoDB's 100 transaction action limit");
  }
  await ctx.doc.send(
    new TransactWriteCommand({
      TransactItems: [...withMarkerTable(ctx, ownedMarkerConditions([...markers])), write],
    }),
  );
}
