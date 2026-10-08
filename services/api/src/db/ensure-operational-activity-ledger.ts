import {
  BatchWriteCommand,
  GetCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
  type BatchWriteCommandInput,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";

import type { DynamoTableNames } from "./dynamo.ts";
import {
  operationalActivitiesForBackfill,
  operationalActivityReadyRecord,
} from "./plane-storage-operational-activity.ts";
import {
  isConditionalFailed,
  isConditionalTransactionFailed,
  itemToSession,
  nextPageKey,
} from "./plane-storage-types.ts";

const SCOPE = "__operational-activity#v2#ready";
const READY = "READY";
const CURSOR = "MIGRATION";
const PAGE_SIZE = 25;
const LEASE_MS = 55_000;
type PendingWrite = NonNullable<
  NonNullable<BatchWriteCommandInput["RequestItems"]>[string]
>[number];

/** One strongly consistent Sessions page per call; only the fenced migration may scan it. */
export async function migrateOperationalActivityLedgerPage(
  doc: DynamoDBDocumentClient,
  tables: Pick<DynamoTableNames, "sessions" | "sessionDrains">,
): Promise<boolean> {
  const ready = await doc.send(
    new GetCommand({
      TableName: tables.sessionDrains,
      Key: { scopeKey: SCOPE, recordKey: READY },
      ConsistentRead: true,
    }),
  );
  if (ready.Item?.recordType === "operational-activity-ready-v2") return true;

  const owner = randomUUID();
  const now = new Date().toISOString();
  let checkpoint: Record<string, unknown>;
  try {
    const claim = await doc.send(
      new UpdateCommand({
        TableName: tables.sessionDrains,
        Key: { scopeKey: SCOPE, recordKey: CURSOR },
        UpdateExpression:
          "SET recordType = :type, leaseOwner = :owner, leaseUntil = :until ADD fence :one",
        ConditionExpression: "attribute_not_exists(leaseUntil) OR leaseUntil < :now",
        ExpressionAttributeValues: {
          ":type": "operational-activity-migration-v2",
          ":owner": owner,
          ":until": new Date(Date.parse(now) + LEASE_MS).toISOString(),
          ":now": now,
          ":one": 1,
        },
        ReturnValues: "ALL_NEW",
      }),
    );
    checkpoint = claim.Attributes as Record<string, unknown>;
  } catch (error) {
    if (isConditionalFailed(error)) return false;
    throw error;
  }
  const fence = checkpoint.fence;
  const startKey = nextPageKey(checkpoint.nextKey as Record<string, unknown> | undefined);
  const page = await doc.send(
    new ScanCommand({
      TableName: tables.sessions,
      ConsistentRead: true,
      Limit: PAGE_SIZE,
      ...(startKey ? { ExclusiveStartKey: startKey } : {}),
    }),
  );
  const items = (page.Items ?? []) as Record<string, unknown>[];
  for (const item of items) {
    if (
      typeof item.completedAt === "string" ||
      !["completed", "failed", "cancelled", "timed_out"].includes(String(item.status))
    )
      continue;
    try {
      await doc.send(
        new UpdateCommand({
          TableName: tables.sessions,
          Key: { id: item.id },
          UpdateExpression: "SET completedAt = :completedAt",
          ConditionExpression:
            "createdAt = :createdAt AND #status = :status AND attribute_not_exists(completedAt)",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":createdAt": item.createdAt,
            ":status": item.status,
            ":completedAt": now,
          },
        }),
      );
      item.completedAt = now;
    } catch (error) {
      if (!isConditionalFailed(error)) throw error;
    }
  }
  const activities = items.flatMap((item) =>
    operationalActivitiesForBackfill(itemToSession(item as Record<string, unknown>)),
  );
  // The maintenance fence retires all old writers and external admission before
  // this idempotent batch write. A failed batch never advances the checkpoint.
  for (let offset = 0; offset < activities.length; offset += PAGE_SIZE) {
    let pending: PendingWrite[] = activities
      .slice(offset, offset + PAGE_SIZE)
      .map((Item) => ({ PutRequest: { Item } }));
    for (let retry = 0; pending.length && retry < 5; retry += 1) {
      const result = await doc.send(
        new BatchWriteCommand({ RequestItems: { [tables.sessionDrains]: pending } }),
      );
      pending = result.UnprocessedItems?.[tables.sessionDrains] ?? [];
    }
    if (pending.length) throw new Error("could not backfill operational activity ledger");
  }
  const nextKey = nextPageKey(page.LastEvaluatedKey as Record<string, unknown> | undefined);
  if (nextKey) {
    await doc.send(
      new UpdateCommand({
        TableName: tables.sessionDrains,
        Key: { scopeKey: SCOPE, recordKey: CURSOR },
        UpdateExpression: "SET nextKey = :nextKey REMOVE leaseOwner, leaseUntil",
        ConditionExpression: "leaseOwner = :owner AND fence = :fence",
        ExpressionAttributeValues: { ":nextKey": nextKey, ":owner": owner, ":fence": fence },
      }),
    );
    return false;
  }
  try {
    await doc.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            ConditionCheck: {
              TableName: tables.sessionDrains,
              Key: { scopeKey: SCOPE, recordKey: CURSOR },
              ConditionExpression: "leaseOwner = :owner AND fence = :fence",
              ExpressionAttributeValues: { ":owner": owner, ":fence": fence },
            },
          },
          {
            Put: {
              TableName: tables.sessionDrains,
              Item: operationalActivityReadyRecord(),
              ConditionExpression: "attribute_not_exists(scopeKey)",
            },
          },
        ],
      }),
    );
    return true;
  } catch (error) {
    if (!isConditionalTransactionFailed(error)) throw error;
    const published = await doc.send(
      new GetCommand({
        TableName: tables.sessionDrains,
        Key: { scopeKey: SCOPE, recordKey: READY },
        ConsistentRead: true,
      }),
    );
    return published.Item?.recordType === "operational-activity-ready-v2";
  }
}
