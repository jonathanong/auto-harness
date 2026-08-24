import {
  DescribeTableCommand,
  KeyType,
  ProjectionType,
  ResourceInUseException,
  ScalarAttributeType,
  UpdateTableCommand,
  type DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";

import type { DynamoTableNames } from "./dynamo.ts";
import { nextPageKey } from "./plane-storage-types.ts";

export const ARCHIVE_RETRY_INDEX = "retryState-retryOrder";
const MIGRATION_SCOPE_KEY = "__archive-retry-migration__";
const MIGRATION_RECORD_KEY = "RETRY-V1";
const MIGRATION_SCAN_LIMIT = 100;
const MIGRATION_LEASE_MS = 55_000;

function isConditionalFailure(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: unknown }).name === "ConditionalCheckFailedException"
  );
}

function isIgnorableIndexUpdate(error: unknown): boolean {
  return (
    error instanceof ResourceInUseException ||
    (typeof error === "object" &&
      error !== null &&
      "name" in error &&
      (error as { name?: unknown }).name === "LimitExceededException")
  );
}

/** Add the pending-archive access path to Archives tables created before retry support. */
export async function ensureArchivesRetryIndex(
  client: DynamoDBClient,
  tableName: string,
): Promise<void> {
  let table;
  try {
    table = await client.send(new DescribeTableCommand({ TableName: tableName }));
  } catch {
    return;
  }
  if (
    table.Table?.GlobalSecondaryIndexes?.some((index) => index.IndexName === ARCHIVE_RETRY_INDEX)
  ) {
    return;
  }
  const definitions = table.Table?.AttributeDefinitions ?? [];
  const withDefinitions = [
    ...definitions.filter(
      (definition) =>
        definition.AttributeName !== "retryState" && definition.AttributeName !== "retryOrder",
    ),
    { AttributeName: "retryState", AttributeType: ScalarAttributeType.S },
    { AttributeName: "retryOrder", AttributeType: ScalarAttributeType.S },
  ];
  try {
    await client.send(
      new UpdateTableCommand({
        TableName: tableName,
        AttributeDefinitions: withDefinitions,
        GlobalSecondaryIndexUpdates: [
          {
            Create: {
              IndexName: ARCHIVE_RETRY_INDEX,
              KeySchema: [
                { AttributeName: "retryState", KeyType: KeyType.HASH },
                { AttributeName: "retryOrder", KeyType: KeyType.RANGE },
              ],
              Projection: { ProjectionType: ProjectionType.ALL },
            },
          },
        ],
      }),
    );
  } catch (error) {
    if (!isIgnorableIndexUpdate(error)) throw error;
  }
}

/** Backfill one bounded, resumable page of legacy objectStored=false rows. */
export async function backfillArchiveRetryIndexPage(
  doc: DynamoDBDocumentClient,
  tables: Pick<DynamoTableNames, "archives" | "sessionDrains">,
): Promise<boolean> {
  const ready = await doc.send(
    new GetCommand({
      TableName: tables.sessionDrains,
      Key: { scopeKey: MIGRATION_SCOPE_KEY, recordKey: MIGRATION_RECORD_KEY },
      ConsistentRead: true,
    }),
  );
  if (ready.Item?.recordType === "archive-retry-v1") return true;

  const owner = randomUUID();
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + MIGRATION_LEASE_MS).toISOString();
  let checkpoint: Record<string, unknown> | undefined;
  try {
    const claimed = await doc.send(
      new UpdateCommand({
        TableName: tables.sessionDrains,
        Key: { scopeKey: MIGRATION_SCOPE_KEY, recordKey: MIGRATION_RECORD_KEY },
        UpdateExpression:
          "SET recordType = :type, leaseOwner = :owner, leaseUntil = :leaseUntil ADD fence :one",
        ConditionExpression: "attribute_not_exists(leaseUntil) OR leaseUntil < :now",
        ExpressionAttributeValues: {
          ":type": "archive-retry-migration-v1",
          ":owner": owner,
          ":leaseUntil": leaseUntil,
          ":now": now.toISOString(),
          ":one": 1,
        },
        ReturnValues: "ALL_NEW",
      }),
    );
    checkpoint = claimed.Attributes as Record<string, unknown> | undefined;
  } catch (error) {
    if (isConditionalFailure(error)) return false;
    throw error;
  }

  const fence = checkpoint?.fence;
  const startKey = nextPageKey(checkpoint?.nextKey as Record<string, unknown> | undefined);
  const page = await doc.send(
    new ScanCommand({
      TableName: tables.archives,
      ConsistentRead: true,
      Limit: MIGRATION_SCAN_LIMIT,
      ...(startKey ? { ExclusiveStartKey: startKey } : {}),
    }),
  );
  for (const item of (page.Items ?? []) as Array<Record<string, unknown>>) {
    if (item.objectStored !== false || typeof item.key !== "string") continue;
    if (typeof item.retryState === "string" && typeof item.retryOrder === "string") continue;
    const updatedAt =
      typeof item.updatedAt === "string" ? item.updatedAt : new Date().toISOString();
    try {
      await doc.send(
        new UpdateCommand({
          TableName: tables.archives,
          Key: { key: item.key },
          UpdateExpression: "SET retryState = :state, retryOrder = :order",
          ConditionExpression: "objectStored = :false AND attribute_not_exists(retryState)",
          ExpressionAttributeValues: {
            ":state": "pending",
            ":order": `${updatedAt}#${item.key}`,
            ":false": false,
          },
        }),
      );
    } catch (error) {
      if (!isConditionalFailure(error)) throw error;
    }
  }

  const nextKey = nextPageKey(page.LastEvaluatedKey as Record<string, unknown> | undefined);
  if (nextKey) {
    await doc.send(
      new UpdateCommand({
        TableName: tables.sessionDrains,
        Key: { scopeKey: MIGRATION_SCOPE_KEY, recordKey: MIGRATION_RECORD_KEY },
        UpdateExpression: "SET nextKey = :nextKey REMOVE leaseOwner, leaseUntil",
        ConditionExpression: "leaseOwner = :owner AND fence = :fence",
        ExpressionAttributeValues: { ":nextKey": nextKey, ":owner": owner, ":fence": fence },
      }),
    );
    return false;
  }
  await doc.send(
    new UpdateCommand({
      TableName: tables.sessionDrains,
      Key: { scopeKey: MIGRATION_SCOPE_KEY, recordKey: MIGRATION_RECORD_KEY },
      UpdateExpression: "SET recordType = :ready REMOVE leaseOwner, leaseUntil, nextKey",
      ConditionExpression: "leaseOwner = :owner AND fence = :fence",
      ExpressionAttributeValues: { ":ready": "archive-retry-v1", ":owner": owner, ":fence": fence },
    }),
  );
  return true;
}
