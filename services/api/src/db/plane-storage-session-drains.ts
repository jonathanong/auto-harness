import {
  GetCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
  type TransactWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";

import type { PlaneStorageCtx, SessionDrainRecord } from "./plane-storage-types.ts";
import { isConditionalFailed, isConditionalTransactionFailed } from "./plane-storage-types.ts";
import { markerConditions, withMarkerTable } from "./plane-storage-deletion-markers.ts";

export function sessionDrainScopeKey(repositoryId: string, principalId: string): string {
  return `${encodeURIComponent(repositoryId)}#${encodeURIComponent(principalId)}`;
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
          {
            ConditionCheck: {
              TableName: ctx.tables.repositories,
              Key: { id: record.repositoryId },
              ConditionExpression: "attribute_exists(id)",
            },
          },
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
    const replay = await getSessionDrainOperation(
      ctx,
      record.repositoryId,
      record.principalId,
      record.operationId,
    );
    if (replay) return { created: false, drain: replay };
    const current = await getSessionDrain(ctx, record.repositoryId, record.principalId);
    if (!current) {
      throw new Error("session drain changed while replaying request", { cause: error });
    }
    return { created: false, drain: current };
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
    if (isConditionalFailed(error)) return null;
    throw error;
  }
}

export async function listSessionDrains(ctx: PlaneStorageCtx): Promise<SessionDrainRecord[]> {
  const records: SessionDrainRecord[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const result = await ctx.doc.send(
      new ScanCommand({ TableName: ctx.tables.sessionDrains, ExclusiveStartKey: startKey }),
    );
    records.push(...((result.Items ?? []) as SessionDrainRecord[]));
    startKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (startKey);
  return records;
}
