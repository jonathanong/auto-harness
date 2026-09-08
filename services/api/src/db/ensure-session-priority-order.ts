/* eslint-disable max-lines -- one fenced migration owns the coupled readiness protocol. */
import {
  DynamoDBDocumentClient,
  GetCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";

import {
  createdOrderKey,
  priorityOrderKey,
  repositoryPriorityOrderKey,
} from "../control-plane-ordering.ts";
import type { DynamoTableNames } from "./dynamo.ts";
import { nextPageKey } from "./plane-storage-types.ts";

export const SESSION_PRIORITY_ORDER_SCOPE_KEY = "__session-priority-order__";
export const SESSION_PRIORITY_ORDER_READY_RECORD_KEY = "READY-V2";
const MIGRATION_RECORD_KEY = "MIGRATION-V2";
const MIGRATION_SCAN_LIMIT = 100;
const MIGRATION_LEASE_MS = 55_000;

function isConditionalFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("name" in error)) return false;
  const dynamoError = error as {
    name?: unknown;
    CancellationReasons?: Array<{ Code?: unknown }>;
  };
  if (dynamoError.name === "ConditionalCheckFailedException") return true;
  return (
    dynamoError.name === "TransactionCanceledException" &&
    (dynamoError.CancellationReasons?.some((reason) => reason.Code === "ConditionalCheckFailed") ??
      false)
  );
}

function priorityKeys(item: Record<string, unknown>): {
  createdOrder: string;
  priorityOrder: string;
  repositoryPriorityOrder: string;
} {
  if (
    typeof item.id !== "string" ||
    item.id.length === 0 ||
    typeof item.repositoryId !== "string" ||
    item.repositoryId.length === 0 ||
    typeof item.createdAt !== "string" ||
    item.createdAt.length === 0 ||
    typeof item.priority !== "number" ||
    !Number.isInteger(item.priority) ||
    item.priority < -10_000 ||
    item.priority > 10_000
  ) {
    const id = typeof item.id === "string" && item.id.length > 0 ? item.id : "<unknown>";
    throw new Error(`cannot migrate malformed session ${id}`);
  }
  const session = { id: item.id, createdAt: item.createdAt, priority: item.priority };
  return {
    createdOrder: createdOrderKey(session),
    priorityOrder: priorityOrderKey(session),
    repositoryPriorityOrder: repositoryPriorityOrderKey(item.repositoryId, session),
  };
}

async function backfillPage(
  doc: DynamoDBDocumentClient,
  tableName: string,
  items: readonly Record<string, unknown>[],
): Promise<void> {
  for (const item of items) {
    const keys = priorityKeys(item);
    if (
      item.createdOrder === keys.createdOrder &&
      item.priorityOrder === keys.priorityOrder &&
      item.repositoryPriorityOrder === keys.repositoryPriorityOrder
    ) {
      continue;
    }
    try {
      await doc.send(
        new UpdateCommand({
          TableName: tableName,
          Key: { id: item.id },
          UpdateExpression:
            "SET createdOrder = :createdOrder, priorityOrder = :priorityOrder, repositoryPriorityOrder = :repositoryPriorityOrder",
          ConditionExpression:
            "attribute_exists(id) AND (attribute_not_exists(createdOrder) OR createdOrder <> :createdOrder OR attribute_not_exists(priorityOrder) OR priorityOrder <> :priorityOrder OR attribute_not_exists(repositoryPriorityOrder) OR repositoryPriorityOrder <> :repositoryPriorityOrder)",
          ExpressionAttributeValues: {
            ":createdOrder": keys.createdOrder,
            ":priorityOrder": keys.priorityOrder,
            ":repositoryPriorityOrder": keys.repositoryPriorityOrder,
          },
        }),
      );
    } catch (error) {
      if (!isConditionalFailure(error)) throw error;
    }
  }
}

/**
 * Backfill one fenced, strongly-consistent page of legacy Session rows.
 *
 * READY is published only after every page was checkpointed. Deployments must
 * retire old writers before running this migration: a legacy PutItem can remove
 * GSI attributes after they have been repaired.
 */
export async function migrateSessionPriorityOrderPage(
  doc: DynamoDBDocumentClient,
  tables: Pick<DynamoTableNames, "sessions" | "sessionDrains">,
): Promise<boolean> {
  const ready = await doc.send(
    new GetCommand({
      TableName: tables.sessionDrains,
      Key: {
        scopeKey: SESSION_PRIORITY_ORDER_SCOPE_KEY,
        recordKey: SESSION_PRIORITY_ORDER_READY_RECORD_KEY,
      },
      ConsistentRead: true,
    }),
  );
  if (ready.Item?.recordType === "session-priority-order-v2") return true;

  const owner = randomUUID();
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + MIGRATION_LEASE_MS).toISOString();
  let checkpoint: Record<string, unknown> | undefined;
  try {
    const claimed = await doc.send(
      new UpdateCommand({
        TableName: tables.sessionDrains,
        Key: { scopeKey: SESSION_PRIORITY_ORDER_SCOPE_KEY, recordKey: MIGRATION_RECORD_KEY },
        UpdateExpression:
          "SET recordType = :type, leaseOwner = :owner, leaseUntil = :leaseUntil ADD fence :one",
        ConditionExpression: "attribute_not_exists(leaseUntil) OR leaseUntil < :now",
        ExpressionAttributeValues: {
          ":type": "session-priority-order-migration-v2",
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
      TableName: tables.sessions,
      ConsistentRead: true,
      Limit: MIGRATION_SCAN_LIMIT,
      ...(startKey ? { ExclusiveStartKey: startKey } : {}),
    }),
  );
  await backfillPage(doc, tables.sessions, (page.Items ?? []) as Record<string, unknown>[]);
  const nextKey = nextPageKey(page.LastEvaluatedKey as Record<string, unknown> | undefined);
  if (nextKey) {
    await doc.send(
      new UpdateCommand({
        TableName: tables.sessionDrains,
        Key: { scopeKey: SESSION_PRIORITY_ORDER_SCOPE_KEY, recordKey: MIGRATION_RECORD_KEY },
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
              Key: { scopeKey: SESSION_PRIORITY_ORDER_SCOPE_KEY, recordKey: MIGRATION_RECORD_KEY },
              ConditionExpression: "leaseOwner = :owner AND fence = :fence",
              ExpressionAttributeValues: { ":owner": owner, ":fence": fence },
            },
          },
          {
            Put: {
              TableName: tables.sessionDrains,
              Item: {
                scopeKey: SESSION_PRIORITY_ORDER_SCOPE_KEY,
                recordKey: SESSION_PRIORITY_ORDER_READY_RECORD_KEY,
                recordType: "session-priority-order-v2",
                readyAt: now.toISOString(),
              },
              ConditionExpression: "attribute_not_exists(scopeKey)",
            },
          },
        ],
      }),
    );
  } catch (error) {
    if (!isConditionalFailure(error)) throw error;
    const published = await doc.send(
      new GetCommand({
        TableName: tables.sessionDrains,
        Key: {
          scopeKey: SESSION_PRIORITY_ORDER_SCOPE_KEY,
          recordKey: SESSION_PRIORITY_ORDER_READY_RECORD_KEY,
        },
        ConsistentRead: true,
      }),
    );
    return published.Item?.recordType === "session-priority-order-v2";
  }
  return true;
}
