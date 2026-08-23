import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
  type BatchWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";
import { randomInt, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import type { DynamoTableNames } from "./dynamo.ts";
import { sessionPrincipalId } from "../control-plane-session-owner.ts";
import { itemToSession, nextPageKey } from "./plane-storage-types.ts";
import {
  sessionDrainActivityKey,
  sessionDrainLedgerReadyRecord,
  sessionDrainScopeKey,
} from "./plane-storage-session-drains.ts";

const LEDGER_SCOPE_KEY = "__session-drain-ledger__";
const LEDGER_RECORD_KEY = "ACTIVITY-V1";
const MIGRATION_RECORD_KEY = "MIGRATION-ACTIVITY-V1";
/** One cron invocation must have a predictable read/write budget. */
const MIGRATION_SCAN_LIMIT = 100;
const MIGRATION_LEASE_MS = 55_000;
const BATCH_SIZE = 25;
const MAX_UNPROCESSED_RETRIES = 5;
const BASE_RETRY_DELAY_MS = 50;
type PendingWrite = NonNullable<
  NonNullable<BatchWriteCommandInput["RequestItems"]>[string]
>[number];

function canStillAffectDrain(session: {
  status: string;
  worktreeId?: string | null;
  mainCheckoutLease?: boolean;
}): boolean {
  return (
    session.status === "queued" ||
    session.status === "running" ||
    (session.status === "cancelled" &&
      (session.worktreeId != null || session.mainCheckoutLease === true))
  );
}

function isConditionalFailure(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    ((error as { name?: unknown }).name === "ConditionalCheckFailedException" ||
      (error as { name?: unknown }).name === "TransactionCanceledException")
  );
}

async function writeActivities(
  doc: DynamoDBDocumentClient,
  tableName: string,
  activities: Record<string, unknown>[],
): Promise<void> {
  for (let index = 0; index < activities.length; index += BATCH_SIZE) {
    let pending: PendingWrite[] = activities
      .slice(index, index + BATCH_SIZE)
      .map((Item) => ({ PutRequest: { Item } }));
    for (let attempt = 0; pending.length && attempt < MAX_UNPROCESSED_RETRIES; attempt += 1) {
      if (attempt > 0) {
        const backoff = BASE_RETRY_DELAY_MS * 2 ** (attempt - 1);
        // Cryptographic randomness is used only to desynchronize retries, never as an identifier.
        await delay(backoff + randomInt(backoff)); // NOSONAR
      }
      const result = await doc.send(
        new BatchWriteCommand({ RequestItems: { [tableName]: pending } }),
      );
      pending = result.UnprocessedItems?.[tableName] ?? [];
    }
    if (pending.length) {
      throw new Error("could not backfill the session drain activity ledger");
    }
  }
}

function activityForItem(item: Record<string, unknown>): Record<string, unknown> | null {
  const session = itemToSession(item);
  const principalId = sessionPrincipalId(session);
  if (!principalId || !canStillAffectDrain(session)) return null;
  return {
    scopeKey: sessionDrainScopeKey(session.repositoryId, principalId),
    recordKey: sessionDrainActivityKey(session.id),
    recordType: "activity",
    sessionId: session.id,
    repositoryId: session.repositoryId,
    principalId,
  };
}

async function backfillPage(
  doc: DynamoDBDocumentClient,
  tableName: string,
  items: Record<string, unknown>[],
): Promise<void> {
  const activities = items
    .map(activityForItem)
    .filter((activity): activity is Record<string, unknown> => activity !== null);
  await writeActivities(doc, tableName, activities);
}

/**
 * Performs one fenced, bounded migration page. A deployment must first roll
 * out ACT-writing session admission and retire old writers; READY stays absent
 * until this worker has checkpointed every historical page.
 */
export async function migrateSessionDrainActivityLedgerPage(
  doc: DynamoDBDocumentClient,
  tables: Pick<DynamoTableNames, "sessions" | "sessionDrains">,
): Promise<boolean> {
  const ready = await doc.send(
    new GetCommand({
      TableName: tables.sessionDrains,
      Key: { scopeKey: LEDGER_SCOPE_KEY, recordKey: LEDGER_RECORD_KEY },
      ConsistentRead: true,
    }),
  );
  if (ready.Item?.recordType === "activity-ledger-v1") return true;

  const owner = randomUUID();
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + MIGRATION_LEASE_MS).toISOString();
  let checkpoint: Record<string, unknown> | undefined;
  try {
    const claimed = await doc.send(
      new UpdateCommand({
        TableName: tables.sessionDrains,
        Key: { scopeKey: LEDGER_SCOPE_KEY, recordKey: MIGRATION_RECORD_KEY },
        UpdateExpression:
          "SET recordType = :type, leaseOwner = :owner, leaseUntil = :leaseUntil ADD fence :one",
        ConditionExpression: "attribute_not_exists(leaseUntil) OR leaseUntil < :now",
        ExpressionAttributeValues: {
          ":type": "activity-ledger-migration-v1",
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
  // Do not move the checkpoint until every idempotent ACT put is durable.
  await backfillPage(doc, tables.sessionDrains, (page.Items ?? []) as Record<string, unknown>[]);
  const nextKey = nextPageKey(page.LastEvaluatedKey as Record<string, unknown> | undefined);
  if (nextKey) {
    await doc.send(
      new UpdateCommand({
        TableName: tables.sessionDrains,
        Key: { scopeKey: LEDGER_SCOPE_KEY, recordKey: MIGRATION_RECORD_KEY },
        UpdateExpression: "SET nextKey = :nextKey REMOVE leaseOwner, leaseUntil",
        ConditionExpression: "leaseOwner = :owner AND fence = :fence",
        ExpressionAttributeValues: {
          ":nextKey": nextKey,
          ":owner": owner,
          ":fence": fence,
        },
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
              Key: { scopeKey: LEDGER_SCOPE_KEY, recordKey: MIGRATION_RECORD_KEY },
              ConditionExpression: "leaseOwner = :owner AND fence = :fence",
              ExpressionAttributeValues: { ":owner": owner, ":fence": fence },
            },
          },
          {
            Put: {
              TableName: tables.sessionDrains,
              Item: sessionDrainLedgerReadyRecord(),
              ConditionExpression: "attribute_not_exists(scopeKey)",
            },
          },
        ],
      }),
    );
  } catch (error) {
    if (!isConditionalFailure(error)) throw error;
  }
  return true;
}

/**
 * Compatibility alias for local provisioning. Production Lambda paths must
 * call the bounded migration page from the scheduler, never during startup.
 */
export const ensureSessionDrainActivityLedger = migrateSessionDrainActivityLedgerPage;
