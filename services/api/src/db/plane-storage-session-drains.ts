/* eslint-disable max-lines */
import {
  DeleteCommand,
  GetCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
  PutCommand,
  type TransactWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";

import type { AuditLogRecord } from "../audit-types.ts";
import { auditLogTransactPut } from "./plane-storage-audit.ts";
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
const RECONCILER_SCOPE_KEY = "__session-drain-reconciler__";
const RECONCILER_RECORD_KEY = "CURSOR-V1";
const RECONCILER_SCAN_LIMIT = 50;
const RECONCILER_MAX_PAGES = 4;

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

/** Coupled to the session transition so a successful cancellation increments
 * exactly once, including after process death or competing reconcilers. */
export function sessionDrainCancellationUpdates(
  ctx: PlaneStorageCtx,
  drain: { repositoryId: string; principalId: string; operationId: string },
): NonNullable<TransactWriteCommandInput["TransactItems"]>[number][] {
  const scopeKey = sessionDrainScopeKey(drain.repositoryId, drain.principalId);
  return ["CURRENT", `OP#${drain.operationId}`].map((recordKey) => ({
    Update: {
      TableName: ctx.tables.sessionDrains,
      Key: { scopeKey, recordKey },
      UpdateExpression: "ADD cancelledCount :one",
      ConditionExpression: "operationId = :operationId AND #status = :draining",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":one": 1,
        ":operationId": drain.operationId,
        ":draining": "draining",
      },
    },
  }));
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

export async function listSessionDrainActivityPage(
  ctx: PlaneStorageCtx,
  repositoryId: string,
  principalId: string,
  startKey?: Record<string, unknown>,
  limit = 25,
): Promise<{ records: SessionDrainActivityRecord[]; nextKey?: Record<string, unknown> }> {
  const result = await ctx.doc.send(
    new QueryCommand({
      TableName: ctx.tables.sessionDrains,
      KeyConditionExpression: "scopeKey = :scopeKey AND begins_with(recordKey, :activityPrefix)",
      ExpressionAttributeValues: {
        ":scopeKey": sessionDrainScopeKey(repositoryId, principalId),
        ":activityPrefix": ACTIVITY_RECORD_PREFIX,
      },
      ConsistentRead: true,
      Limit: limit,
      ...(startKey ? { ExclusiveStartKey: startKey } : {}),
    }),
  );
  const nextKey = nextPageKey(result.LastEvaluatedKey as Record<string, unknown> | undefined);
  return {
    records: (result.Items ?? []) as SessionDrainActivityRecord[],
    ...(nextKey ? { nextKey } : {}),
  };
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
  audit: AuditLogRecord,
): Promise<{ created: boolean; drain: SessionDrainRecord }> {
  const scopeKey = sessionDrainScopeKey(record.repositoryId, record.principalId);
  const principalCheck = principalExistsCheck(ctx, record.principalId);
  const markers = [
    { key: `repository:${record.repositoryId}`, now: record.requestedAt },
    ...(record.principalId && record.principalId !== "system"
      ? [{ key: `principal:${record.principalId}`, now: record.requestedAt }]
      : []),
  ];
  const markerCount = markers.length;
  const principalCheckIndex = markerCount;
  const repositoryCheckIndex = principalCheckIndex + (principalCheck ? 1 : 0);
  const ledgerCheckIndex = repositoryCheckIndex + 1;
  try {
    await ctx.doc.send(
      new TransactWriteCommand({
        TransactItems: [
          ...withMarkerTable(ctx, markerConditions(markers)),
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
          auditLogTransactPut(ctx, audit),
        ],
      }),
    );
    return { created: true, drain: { ...record, scopeKey } };
  } catch (error) {
    if (!isConditionalTransactionFailed(error)) throw error;
    if (
      [...Array(markerCount).keys()].some((index) =>
        isConditionalTransactionFailureAt(error, index),
      ) ||
      (principalCheck !== null && isConditionalTransactionFailureAt(error, principalCheckIndex)) ||
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
  audit?: AuditLogRecord,
): Promise<boolean> {
  if (record.status !== "draining" && !audit) {
    throw new Error("terminal session drain updates require an audit record");
  }
  const scopeKey = sessionDrainScopeKey(record.repositoryId, record.principalId);
  const { reconcileLeaseOwner, reconcileLeaseUntil: _reconcileLeaseUntil, ...checkpoint } = record;
  try {
    await ctx.doc.send(
      new TransactWriteCommand({
        TransactItems: [
          ...["CURRENT", `OP#${record.operationId}`].map((recordKey) => ({
            Put: {
              TableName: ctx.tables.sessionDrains,
              // Checkpointing releases the short reconcile lease atomically. A
              // crashed worker leaves its old lease to expire; a successful
              // worker never delays the next bounded page or status poll.
              Item: { ...checkpoint, scopeKey, recordKey },
              ConditionExpression:
                "operationId = :operationId AND #status = :draining AND cancelledCount <= :cancelledCount" +
                (recordKey.startsWith("OP#") && reconcileLeaseOwner
                  ? " AND reconcileLeaseOwner = :leaseOwner"
                  : ""),
              ExpressionAttributeNames: { "#status": "status" },
              ExpressionAttributeValues: {
                ":operationId": record.operationId,
                ":draining": "draining",
                ":cancelledCount": record.cancelledCount,
                ...(recordKey.startsWith("OP#") && reconcileLeaseOwner
                  ? { ":leaseOwner": reconcileLeaseOwner }
                  : {}),
              },
            },
          })),
          ...(audit ? [auditLogTransactPut(ctx, audit)] : []),
        ],
      }),
    );
    return true;
  } catch (error) {
    if (isConditionalTransactionFailed(error)) return false;
    throw error;
  }
}

/** Only the lease owner may checkpoint a paged drain sweep. A stale Lambda can
 * still finish its reads, but its OP-row conditional write cannot regress the
 * cursor or terminal result. */
export async function claimSessionDrainReconcile(
  ctx: PlaneStorageCtx,
  record: SessionDrainRecord,
  owner: string,
  now: string,
): Promise<SessionDrainRecord | null> {
  const until = new Date(Date.parse(now) + 55_000).toISOString();
  try {
    const result = await ctx.doc.send(
      new UpdateCommand({
        TableName: ctx.tables.sessionDrains,
        Key: {
          scopeKey: sessionDrainScopeKey(record.repositoryId, record.principalId),
          recordKey: `OP#${record.operationId}`,
        },
        UpdateExpression: "SET reconcileLeaseOwner = :owner, reconcileLeaseUntil = :until",
        ConditionExpression:
          "operationId = :operationId AND #status = :draining AND (attribute_not_exists(reconcileLeaseUntil) OR reconcileLeaseUntil < :now)",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":owner": owner,
          ":until": until,
          ":now": now,
          ":operationId": record.operationId,
          ":draining": "draining",
        },
        ReturnValues: "ALL_NEW",
      }),
    );
    return result.Attributes as SessionDrainRecord;
  } catch (error) {
    if (isConditionalFailed(error)) return null;
    throw error;
  }
}

export async function releaseSessionDrain(
  ctx: PlaneStorageCtx,
  repositoryId: string,
  principalId: string,
  operationId: string,
  now: string,
  audit: AuditLogRecord,
): Promise<SessionDrainRecord | null> {
  try {
    await ctx.doc.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: ctx.tables.sessionDrains,
              Key: {
                scopeKey: sessionDrainScopeKey(repositoryId, principalId),
                recordKey: "CURRENT",
              },
              UpdateExpression: "SET #status = :released, releasedAt = :now, updatedAt = :now",
              ConditionExpression:
                "operationId = :operationId AND #status IN (:succeeded, :failed)",
              ExpressionAttributeNames: { "#status": "status" },
              ExpressionAttributeValues: {
                ":operationId": operationId,
                ":succeeded": "succeeded",
                ":failed": "failed",
                ":released": "released",
                ":now": now,
              },
            },
          },
          auditLogTransactPut(ctx, audit),
        ],
      }),
    );
    return getSessionDrain(ctx, repositoryId, principalId);
  } catch (error) {
    if (!isConditionalTransactionFailed(error)) throw error;
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

/**
 * Returns a fixed, round-robin candidate budget. The selector cursor is
 * durable because Lambda processes are short lived; limiting both scan pages
 * and candidates prevents a large ACT partition from starving later drains.
 * Candidate scans are only scheduling hints—each drain is subsequently
 * strong-read and fenced before mutation.
 */
export async function listSessionDrainReconcileCandidates(
  ctx: PlaneStorageCtx,
  limit = 10,
): Promise<SessionDrainRecord[]> {
  const cursor = await ctx.doc.send(
    new GetCommand({
      TableName: ctx.tables.sessionDrains,
      Key: { scopeKey: RECONCILER_SCOPE_KEY, recordKey: RECONCILER_RECORD_KEY },
      ConsistentRead: true,
    }),
  );
  let startKey = nextPageKey(cursor.Item?.nextKey as Record<string, unknown> | undefined);
  const candidates: SessionDrainRecord[] = [];
  for (let page = 0; page < RECONCILER_MAX_PAGES && candidates.length < limit; page += 1) {
    const result = await ctx.doc.send(
      new ScanCommand({
        TableName: ctx.tables.sessionDrains,
        Limit: RECONCILER_SCAN_LIMIT,
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }),
    );
    let stoppedAtCandidate: Record<string, unknown> | undefined;
    for (const item of (result.Items ?? []) as SessionDrainRecord[]) {
      if (item.recordKey === "CURRENT" && item.status === "draining") candidates.push(item);
      if (candidates.length === limit) {
        stoppedAtCandidate = { scopeKey: item.scopeKey, recordKey: item.recordKey };
        break;
      }
    }
    startKey =
      stoppedAtCandidate ??
      nextPageKey(result.LastEvaluatedKey as Record<string, unknown> | undefined);
    if (!startKey) break;
  }
  if (startKey) {
    await ctx.doc.send(
      new PutCommand({
        TableName: ctx.tables.sessionDrains,
        Item: {
          scopeKey: RECONCILER_SCOPE_KEY,
          recordKey: RECONCILER_RECORD_KEY,
          recordType: "session-drain-reconcile-cursor-v1",
          nextKey: startKey,
        },
      }),
    );
  } else {
    await ctx.doc.send(
      new DeleteCommand({
        TableName: ctx.tables.sessionDrains,
        Key: { scopeKey: RECONCILER_SCOPE_KEY, recordKey: RECONCILER_RECORD_KEY },
      }),
    );
  }
  return candidates;
}
