import {
  GetCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";

import { routeWorktreeIdOf, SESSION_LIST_PARTITION_VALUE } from "../control-plane-ordering.ts";
import type { DynamoTableNames } from "./dynamo.ts";
import { nextPageKey } from "./plane-storage-types.ts";
import {
  SESSION_LIST_INDEXES_READY_RECORD_KEY,
  SESSION_LIST_INDEXES_READY_RECORD_TYPE,
  SESSION_LIST_INDEXES_SCOPE_KEY,
} from "./session-list-index-readiness.ts";

const MIGRATION_RECORD_KEY = "MIGRATION-V1";
const SCAN_LIMIT = 100;
const LEASE_MS = 55_000;
const MAX_ROW_ATTEMPTS = 5;

function isConditionalFailure(error: unknown): boolean {
  const failure = error as { name?: unknown; CancellationReasons?: Array<{ Code?: unknown }> };
  return (
    failure?.name === "ConditionalCheckFailedException" ||
    (failure?.name === "TransactionCanceledException" &&
      (failure.CancellationReasons?.some((reason) => reason.Code === "ConditionalCheckFailed") ??
        false))
  );
}

/**
 * Give one legacy row its `sessionList` / `routeWorktreeId` index attributes. The writers of
 * the new runtime keep `routeWorktreeId` current without touching `sessionList`, so this
 * write is conditioned on the route it observed: if an assignment lands in between, the row
 * is re-read and recomputed rather than overwritten with a stale route.
 */
async function backfillRow(
  doc: DynamoDBDocumentClient,
  table: string,
  first: Record<string, unknown>,
): Promise<void> {
  let item: Record<string, unknown> | undefined = first;
  for (let attempt = 0; item && attempt < MAX_ROW_ATTEMPTS; attempt += 1) {
    const routeWorktreeId = routeWorktreeIdOf(item);
    if (
      item.sessionList === SESSION_LIST_PARTITION_VALUE &&
      item.routeWorktreeId === routeWorktreeId
    ) {
      return;
    }
    const route = item.resolvedRoute as { attemptId?: unknown } | undefined;
    const routeCondition =
      route === undefined
        ? "attribute_not_exists(resolvedRoute)"
        : typeof route.attemptId === "string"
          ? "resolvedRoute.attemptId = :attemptId"
          : "attribute_exists(resolvedRoute)";
    try {
      await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { id: item.id },
          UpdateExpression: `SET sessionList = :all${
            routeWorktreeId ? ", routeWorktreeId = :routeWorktreeId" : ""
          }${routeWorktreeId ? "" : " REMOVE routeWorktreeId"}`,
          ConditionExpression: `attribute_exists(id) AND ${routeCondition}`,
          ExpressionAttributeValues: {
            ":all": SESSION_LIST_PARTITION_VALUE,
            ...(routeWorktreeId ? { ":routeWorktreeId": routeWorktreeId } : {}),
            ...(typeof route?.attemptId === "string" ? { ":attemptId": route.attemptId } : {}),
          },
        }),
      );
      return;
    } catch (error) {
      if (!isConditionalFailure(error)) throw error;
      const reread = await doc.send(
        new GetCommand({ TableName: table, Key: { id: item.id }, ConsistentRead: true }),
      );
      item = reread.Item as Record<string, unknown> | undefined;
    }
  }
}

const readyKey = {
  scopeKey: SESSION_LIST_INDEXES_SCOPE_KEY,
  recordKey: SESSION_LIST_INDEXES_READY_RECORD_KEY,
};
const leaseKey = { scopeKey: SESSION_LIST_INDEXES_SCOPE_KEY, recordKey: MIGRATION_RECORD_KEY };

async function isPublished(doc: DynamoDBDocumentClient, table: string): Promise<boolean> {
  const ready = await doc.send(
    new GetCommand({ TableName: table, Key: readyKey, ConsistentRead: true }),
  );
  return ready.Item?.recordType === SESSION_LIST_INDEXES_READY_RECORD_TYPE;
}

/**
 * Backfill one leased, strongly consistent page of Session rows, resuming from the stored
 * scan key; the READY marker is published only after the last page. Idempotent and safe to
 * run unfenced after the runtime that writes the attributes is live: rows written by it are
 * skipped, and a concurrent route change makes the row re-read. The caller must have
 * verified that the three indexes are ACTIVE before the first page.
 */
export async function migrateSessionListIndexesPage(
  doc: DynamoDBDocumentClient,
  tables: Pick<DynamoTableNames, "sessions" | "sessionDrains">,
): Promise<boolean> {
  if (await isPublished(doc, tables.sessionDrains)) return true;
  const owner = randomUUID();
  const now = new Date();
  let checkpoint: Record<string, unknown> | undefined;
  try {
    const claimed = await doc.send(
      new UpdateCommand({
        TableName: tables.sessionDrains,
        Key: leaseKey,
        UpdateExpression:
          "SET recordType = :type, leaseOwner = :owner, leaseUntil = :leaseUntil ADD fence :one",
        ConditionExpression: "attribute_not_exists(leaseUntil) OR leaseUntil < :now",
        ExpressionAttributeValues: {
          ":type": "session-list-indexes-migration-v1",
          ":owner": owner,
          ":leaseUntil": new Date(now.getTime() + LEASE_MS).toISOString(),
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
      Limit: SCAN_LIMIT,
      ...(startKey ? { ExclusiveStartKey: startKey } : {}),
    }),
  );
  for (const item of (page.Items ?? []) as Record<string, unknown>[]) {
    await backfillRow(doc, tables.sessions, item);
  }
  const nextKey = nextPageKey(page.LastEvaluatedKey as Record<string, unknown> | undefined);
  const leaseCheck = "leaseOwner = :owner AND fence = :fence";
  const leaseValues = { ":owner": owner, ":fence": fence };
  if (nextKey) {
    await doc.send(
      new UpdateCommand({
        TableName: tables.sessionDrains,
        Key: leaseKey,
        UpdateExpression: "SET nextKey = :nextKey REMOVE leaseOwner, leaseUntil",
        ConditionExpression: leaseCheck,
        ExpressionAttributeValues: { ...leaseValues, ":nextKey": nextKey },
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
              Key: leaseKey,
              ConditionExpression: leaseCheck,
              ExpressionAttributeValues: leaseValues,
            },
          },
          {
            Put: {
              TableName: tables.sessionDrains,
              Item: {
                ...readyKey,
                recordType: SESSION_LIST_INDEXES_READY_RECORD_TYPE,
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
    return isPublished(doc, tables.sessionDrains);
  }
  return true;
}
