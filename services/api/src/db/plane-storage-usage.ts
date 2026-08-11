import { QueryCommand, ScanCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import type { UsageRecord } from "./types.ts";
import { isConditionalFailed } from "./plane-storage-types.ts";
import type { PlaneStorageCtx } from "./plane-storage-types.ts";

function key(record: UsageRecord): string {
  return `${record.attemptId}#${String(record.sequence).padStart(16, "0")}`;
}

export async function putUsageRecord(
  ctx: PlaneStorageCtx,
  record: UsageRecord,
  fence?: { hostId: string; connectionId: string },
): Promise<boolean> {
  // The kind marker and usage record must be committed together. Callers that
  // cannot provide the host epoch must reject the report before reaching
  // storage; keep this guard here too so direct storage callers cannot revive
  // the old racy plain-Put path.
  if (!fence) return false;
  const item = { ...record, usageKey: key(record) };
  try {
    // Both the host lock and current session attempt are part of the
    // transaction: a reconnect or reassignment between read and write
    // cannot publish usage for the old epoch.
    await ctx.doc.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            ConditionCheck: {
              TableName: ctx.tables.hostLocks,
              Key: { hostId: fence.hostId },
              ConditionExpression: "connectionId = :connectionId",
              ExpressionAttributeValues: { ":connectionId": fence.connectionId },
            },
          },
          {
            ConditionCheck: {
              TableName: ctx.tables.sessions,
              Key: { id: record.sessionId },
              ConditionExpression: "attemptId = :attemptId AND worktreeId = :worktreeId",
              ExpressionAttributeValues: {
                ":attemptId": record.attemptId,
                ":worktreeId": record.worktreeId,
              },
            },
          },
          {
            Put: {
              TableName: ctx.tables.sessionUsageKinds,
              Item: {
                sessionAttempt: `${record.sessionId}\0${record.attemptId}`,
                kind: record.kind,
              },
              ConditionExpression: "attribute_not_exists(sessionAttempt) OR kind = :kind",
              ExpressionAttributeValues: { ":kind": record.kind },
            },
          },
          {
            Put: {
              TableName: ctx.tables.sessionUsage,
              Item: item,
              ConditionExpression:
                "attribute_not_exists(sessionId) AND attribute_not_exists(usageKey)",
            },
          },
        ],
      }),
    );
    return true;
  } catch (err) {
    if (
      isConditionalFailed(err) ||
      (err instanceof Error && err.name === "TransactionCanceledException")
    ) {
      return false;
    }
    throw err;
  }
}

export async function listUsageRecords(
  ctx: PlaneStorageCtx,
  sessionId?: string,
): Promise<UsageRecord[]> {
  if (sessionId) {
    const result = await ctx.doc.send(
      new QueryCommand({
        TableName: ctx.tables.sessionUsage,
        KeyConditionExpression: "sessionId = :sessionId",
        ExpressionAttributeValues: { ":sessionId": sessionId },
      }),
    );
    return (result.Items ?? []) as UsageRecord[];
  }
  const records: UsageRecord[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const result = await ctx.doc.send(
      new ScanCommand({
        TableName: ctx.tables.sessionUsage,
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }),
    );
    records.push(...((result.Items ?? []) as UsageRecord[]));
    startKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (startKey);
  return records;
}
