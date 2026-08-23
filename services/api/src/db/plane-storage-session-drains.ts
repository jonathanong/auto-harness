/* eslint-disable max-lines */
import {
  DeleteCommand,
  GetCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
  type TransactWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";

import {
  isConditionalFailed,
  isConditionalTransactionFailureAt,
  isConditionalTransactionFailed,
  nextPageKey,
  type PlaneStorageCtx,
  type SessionDrainRecord,
} from "./plane-storage-types.ts";
import {
  markerConditions,
  principalExistsCheck,
  withMarkerTable,
} from "./plane-storage-deletion-markers.ts";

const ACTIVITY_RECORD_PREFIX = "ACT#";
const LEDGER_SCOPE_KEY = "__session-drain-ledger__";
const LEDGER_RECORD_KEY = "ACTIVITY-V1";

export class SessionDrainScopeUnavailableError extends Error {
  constructor() {
    super("session drain scope is unavailable");
    this.name = "SessionDrainScopeUnavailableError";
  }
}

export class SessionDrainLedgerUnavailableError extends Error {
  constructor() {
    super("session drain activity ledger is not ready");
    this.name = "SessionDrainLedgerUnavailableError";
  }
}

export function isSessionDrainScopeUnavailable(error: unknown): boolean {
  return error instanceof SessionDrainScopeUnavailableError;
}

export function isSessionDrainLedgerUnavailable(error: unknown): boolean {
  return error instanceof SessionDrainLedgerUnavailableError;
}

export function sessionDrainScopeKey(repositoryId: string, principalId: string): string {
  return `${encodeURIComponent(repositoryId)}#${encodeURIComponent(principalId)}`;
}

/**
 * A principal scope contains the drain operation rows plus one durable member
 * row for every session that can still affect quiescence.  The member is a
 * base-table row, not a secondary-index projection, so its absence can be
 * proved with a strongly consistent query.
 */
type SessionDrainActivityRecord = {
  scopeKey: string;
  recordKey: string;
  recordType: "activity";
  sessionId: string;
  repositoryId: string;
  principalId: string;
};

export function sessionDrainActivityKey(sessionId: string): string {
  return `${ACTIVITY_RECORD_PREFIX}${sessionId}`;
}

export function sessionDrainActivityPut(
  ctx: PlaneStorageCtx,
  session: {
    id: string;
    repositoryId: string;
    principalId?: string;
    metadata?: Record<string, unknown>;
  },
): NonNullable<TransactWriteCommandInput["TransactItems"]>[number] | null {
  const principalId =
    session.principalId ??
    (typeof session.metadata?.createdBy === "string" ? session.metadata.createdBy : undefined);
  if (!principalId) return null;
  // Do not condition this put on ACT absence. The same transaction's Session
  // Put condition makes a live ID collision fail atomically; permitting this
  // overwrite repairs a stale ACT left by an older terminal path so an ID can
  // be retried. A stale row in a different immutable scope is harmless and
  // is deleted when that scope is strongly reconciled.
  return {
    Put: {
      TableName: ctx.tables.sessionDrains,
      Item: {
        scopeKey: sessionDrainScopeKey(session.repositoryId, principalId),
        recordKey: sessionDrainActivityKey(session.id),
        recordType: "activity",
        sessionId: session.id,
        repositoryId: session.repositoryId,
        principalId,
      } satisfies SessionDrainActivityRecord,
    },
  };
}

function sessionDrainLedgerProofCheck(
  ctx: PlaneStorageCtx,
): NonNullable<TransactWriteCommandInput["TransactItems"]>[number] {
  return {
    ConditionCheck: {
      TableName: ctx.tables.sessionDrains,
      Key: { scopeKey: LEDGER_SCOPE_KEY, recordKey: LEDGER_RECORD_KEY },
      ConditionExpression: "recordType = :recordType",
      ExpressionAttributeValues: { ":recordType": "activity-ledger-v1" },
    },
  };
}

export function sessionDrainLedgerReadyRecord(): Record<string, string> {
  return {
    scopeKey: LEDGER_SCOPE_KEY,
    recordKey: LEDGER_RECORD_KEY,
    recordType: "activity-ledger-v1",
  };
}

export async function listSessionDrainActivities(
  ctx: PlaneStorageCtx,
  repositoryId: string,
  principalId: string,
): Promise<SessionDrainActivityRecord[]> {
  const records: SessionDrainActivityRecord[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const result = await ctx.doc.send(
      new QueryCommand({
        TableName: ctx.tables.sessionDrains,
        KeyConditionExpression: "scopeKey = :scopeKey AND begins_with(recordKey, :activityPrefix)",
        ExpressionAttributeValues: {
          ":scopeKey": sessionDrainScopeKey(repositoryId, principalId),
          ":activityPrefix": ACTIVITY_RECORD_PREFIX,
        },
        ConsistentRead: true,
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }),
    );
    records.push(...((result.Items ?? []) as SessionDrainActivityRecord[]));
    startKey = nextPageKey(result.LastEvaluatedKey as Record<string, unknown> | undefined);
  } while (startKey);
  return records;
}

/** Delete only the exact activity member that a strong session read proved terminal or stale. */
export async function deleteSessionDrainActivity(
  ctx: PlaneStorageCtx,
  activity: SessionDrainActivityRecord,
): Promise<void> {
  try {
    await ctx.doc.send(
      new DeleteCommand({
        TableName: ctx.tables.sessionDrains,
        Key: { scopeKey: activity.scopeKey, recordKey: activity.recordKey },
        ConditionExpression: "recordType = :recordType AND sessionId = :sessionId",
        ExpressionAttributeValues: {
          ":recordType": "activity",
          ":sessionId": activity.sessionId,
        },
      }),
    );
  } catch (error) {
    if (!isConditionalFailed(error)) throw error;
  }
}

export function sessionDrainAdmissionCheck(
  ctx: PlaneStorageCtx,
  repositoryId: string,
  principalId: string | undefined,
): NonNullable<TransactWriteCommandInput["TransactItems"]>[number] | null {
  if (!principalId) return null;
  return {
    ConditionCheck: {
      TableName: ctx.tables.sessionDrains,
      Key: { scopeKey: sessionDrainScopeKey(repositoryId, principalId), recordKey: "CURRENT" },
      ConditionExpression: "attribute_not_exists(scopeKey) OR #status = :released",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":released": "released" },
    },
  };
}

export async function getSessionDrain(
  ctx: PlaneStorageCtx,
  repositoryId: string,
  principalId: string,
  consistentRead = true,
): Promise<SessionDrainRecord | null> {
  const result = await ctx.doc.send(
    new GetCommand({
      TableName: ctx.tables.sessionDrains,
      Key: {
        scopeKey: sessionDrainScopeKey(repositoryId, principalId),
        recordKey: "CURRENT",
      },
      ConsistentRead: consistentRead,
    }),
  );
  return (result.Item as SessionDrainRecord | undefined) ?? null;
}

export async function getSessionDrainOperation(
  ctx: PlaneStorageCtx,
  repositoryId: string,
  principalId: string,
  operationId: string,
): Promise<SessionDrainRecord | null> {
  const result = await ctx.doc.send(
    new GetCommand({
      TableName: ctx.tables.sessionDrains,
      Key: {
        scopeKey: sessionDrainScopeKey(repositoryId, principalId),
        recordKey: `OP#${operationId}`,
      },
      ConsistentRead: true,
    }),
  );
  return (result.Item as SessionDrainRecord | undefined) ?? null;
}

export async function createOrGetSessionDrain(
  ctx: PlaneStorageCtx,
  record: SessionDrainRecord,
): Promise<{ created: boolean; drain: SessionDrainRecord }> {
  const scopeKey = sessionDrainScopeKey(record.repositoryId, record.principalId);
  const principalCheck = principalExistsCheck(ctx, record.principalId);
  const repositoryCheckIndex = 1 + (principalCheck ? 1 : 0);
  const ledgerCheckIndex = repositoryCheckIndex + 1;
  try {
    await ctx.doc.send(
      new TransactWriteCommand({
        TransactItems: [
          ...withMarkerTable(
            ctx,
            markerConditions([
              { key: `repository:${record.repositoryId}`, now: record.requestedAt },
            ]),
          ),
          ...(principalCheck ? [principalCheck] : []),
          {
            ConditionCheck: {
              TableName: ctx.tables.repositories,
              Key: { id: record.repositoryId },
              ConditionExpression: "attribute_exists(id)",
            },
          },
          sessionDrainLedgerProofCheck(ctx),
          {
            Put: {
              TableName: ctx.tables.sessionDrains,
              Item: { ...record, scopeKey, recordKey: "CURRENT" },
              ConditionExpression: "attribute_not_exists(scopeKey) OR #status = :released",
              ExpressionAttributeNames: { "#status": "status" },
              ExpressionAttributeValues: { ":released": "released" },
            },
          },
          {
            Put: {
              TableName: ctx.tables.sessionDrains,
              Item: { ...record, scopeKey, recordKey: `OP#${record.operationId}` },
              ConditionExpression: "attribute_not_exists(scopeKey)",
            },
          },
        ],
      }),
    );
    return { created: true, drain: { ...record, scopeKey } };
  } catch (error) {
    if (!isConditionalTransactionFailed(error)) throw error;
    if (
      isConditionalTransactionFailureAt(error, 0) ||
      (principalCheck !== null && isConditionalTransactionFailureAt(error, 1)) ||
      isConditionalTransactionFailureAt(error, repositoryCheckIndex)
    ) {
      throw new SessionDrainScopeUnavailableError();
    }
    if (isConditionalTransactionFailureAt(error, ledgerCheckIndex)) {
      throw new SessionDrainLedgerUnavailableError();
    }
    const replay = await getSessionDrainOperation(
      ctx,
      record.repositoryId,
      record.principalId,
      record.operationId,
    );
    if (replay) return { created: false, drain: replay };
    // A different active operation proves this scope is occupied, but it is
    // not a replay of this request. A missing OP row means the requested key
    // is not durably bound, irrespective of the CURRENT row's state.
    throw new SessionDrainScopeUnavailableError();
  }
}

export async function updateSessionDrain(
  ctx: PlaneStorageCtx,
  record: SessionDrainRecord,
): Promise<boolean> {
  const scopeKey = sessionDrainScopeKey(record.repositoryId, record.principalId);
  try {
    await ctx.doc.send(
      new TransactWriteCommand({
        TransactItems: ["CURRENT", `OP#${record.operationId}`].map((recordKey) => ({
          Put: {
            TableName: ctx.tables.sessionDrains,
            Item: { ...record, scopeKey, recordKey },
            ConditionExpression:
              "operationId = :operationId AND #status = :draining AND cancelledCount <= :cancelledCount",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: {
              ":operationId": record.operationId,
              ":draining": "draining",
              ":cancelledCount": record.cancelledCount,
            },
          },
        })),
      }),
    );
    return true;
  } catch (error) {
    if (isConditionalTransactionFailed(error)) return false;
    throw error;
  }
}

export async function releaseSessionDrain(
  ctx: PlaneStorageCtx,
  repositoryId: string,
  principalId: string,
  operationId: string,
  now: string,
): Promise<SessionDrainRecord | null> {
  try {
    const result = await ctx.doc.send(
      new UpdateCommand({
        TableName: ctx.tables.sessionDrains,
        Key: {
          scopeKey: sessionDrainScopeKey(repositoryId, principalId),
          recordKey: "CURRENT",
        },
        UpdateExpression: "SET #status = :released, releasedAt = :now, updatedAt = :now",
        ConditionExpression: "operationId = :operationId AND #status IN (:succeeded, :failed)",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":operationId": operationId,
          ":succeeded": "succeeded",
          ":failed": "failed",
          ":released": "released",
          ":now": now,
        },
        ReturnValues: "ALL_NEW",
      }),
    );
    return (result.Attributes as SessionDrainRecord | undefined) ?? null;
  } catch (error) {
    if (!isConditionalFailed(error)) throw error;
    const current = await getSessionDrain(ctx, repositoryId, principalId);
    return current?.operationId === operationId && current.status === "released" ? current : null;
  }
}

/**
 * List drain rows. Callers making an admission/deletion decision must request
 * a strongly consistent scan; the default stays eventually consistent for
 * background cleanup callers where the extra read capacity is unnecessary.
 */
export async function listSessionDrains(
  ctx: PlaneStorageCtx,
  consistentRead = false,
): Promise<SessionDrainRecord[]> {
  const records: SessionDrainRecord[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const result = await ctx.doc.send(
      new ScanCommand({
        TableName: ctx.tables.sessionDrains,
        ...(consistentRead ? { ConsistentRead: true } : {}),
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }),
    );
    records.push(
      ...((result.Items ?? []) as SessionDrainRecord[]).filter(
        (record) => record.recordKey === "CURRENT" || record.recordKey.startsWith("OP#"),
      ),
    );
    startKey = nextPageKey(result.LastEvaluatedKey as Record<string, unknown> | undefined);
  } while (startKey);
  return records;
}
