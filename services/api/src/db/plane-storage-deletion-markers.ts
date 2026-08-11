import {
  DeleteCommand,
  PutCommand,
  TransactWriteCommand,
  type TransactWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";

import { isConditionalFailed, type PlaneStorageCtx } from "./plane-storage-types.ts";

const PREFIX = "catalog-delete:";

export type DeletionMarker = { key: string; now: string };

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

/** A short marker in the existing concurrency-lock namespace serializes catalog removal. */
export async function acquireDeletionMarker(
  ctx: PlaneStorageCtx,
  key: string,
  owner: string,
  now: string,
  leaseMs = 30_000,
): Promise<boolean> {
  const at = Date.parse(now);
  const expiresAt = new Date((Number.isFinite(at) ? at : Date.now()) + leaseMs).toISOString();
  try {
    await ctx.doc.send(
      new PutCommand({
        TableName: ctx.tables.concurrencyLocks,
        Item: { concurrencyId: `${PREFIX}${key}`, deletionOwner: owner, expiresAt },
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
  await ctx.doc.send(
    new TransactWriteCommand({
      TransactItems: [...withMarkerTable(ctx, markerConditions([...markers])), write],
    }),
  );
}
