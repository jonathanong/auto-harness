import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
  type BatchWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";

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
const BATCH_SIZE = 25;
const MAX_UNPROCESSED_RETRIES = 3;
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
    (error as { name?: unknown }).name === "ConditionalCheckFailedException"
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

/**
 * Establish the one-time proof boundary for the strongly-consistent drain
 * ledger. It is safe to call from every cold start: a ready marker makes the
 * common path one strongly consistent Get, while concurrent bootstrap callers
 * only repeat idempotent ACT puts and race on one conditional marker write.
 *
 * Deployments must retire old control-plane writers before the first call.
 * New writers register ACT rows in their session-creation transaction, but an
 * old binary can create an untracked session while this bounded one-time scan
 * runs. We therefore fail drain creation closed until this marker exists.
 */
export async function ensureSessionDrainActivityLedger(
  doc: DynamoDBDocumentClient,
  tables: Pick<DynamoTableNames, "sessions" | "sessionDrains">,
): Promise<void> {
  const ready = await doc.send(
    new GetCommand({
      TableName: tables.sessionDrains,
      Key: { scopeKey: LEDGER_SCOPE_KEY, recordKey: LEDGER_RECORD_KEY },
      ConsistentRead: true,
    }),
  );
  if (ready.Item?.recordType === "activity-ledger-v1") return;

  let activities: Record<string, unknown>[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await doc.send(
      new ScanCommand({
        TableName: tables.sessions,
        ConsistentRead: true,
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }),
    );
    for (const item of page.Items ?? []) {
      const session = itemToSession(item as Record<string, unknown>);
      const principalId = sessionPrincipalId(session);
      if (!principalId || !canStillAffectDrain(session)) continue;
      activities.push({
        scopeKey: sessionDrainScopeKey(session.repositoryId, principalId),
        recordKey: sessionDrainActivityKey(session.id),
        recordType: "activity",
        sessionId: session.id,
        repositoryId: session.repositoryId,
        principalId,
      });
      if (activities.length === BATCH_SIZE) {
        await writeActivities(doc, tables.sessionDrains, activities);
        activities = [];
      }
    }
    startKey = nextPageKey(page.LastEvaluatedKey as Record<string, unknown> | undefined);
  } while (startKey);

  if (activities.length) await writeActivities(doc, tables.sessionDrains, activities);
  try {
    await doc.send(
      new PutCommand({
        TableName: tables.sessionDrains,
        Item: sessionDrainLedgerReadyRecord(),
        ConditionExpression: "attribute_not_exists(scopeKey)",
      }),
    );
  } catch (error) {
    if (!isConditionalFailure(error)) throw error;
  }
}
