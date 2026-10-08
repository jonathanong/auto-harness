import { BatchWriteCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";

import type { PlaneStorageCtx } from "./plane-storage-types.ts";

/** Remove at most 25 session-owned rows; the next call reads only remaining work. */
export async function deleteSessionRetentionRelatedPage(
  ctx: PlaneStorageCtx,
  sessionId: string,
  kind: "usage" | "logs" | "outputs",
): Promise<boolean> {
  const table =
    kind === "usage"
      ? ctx.tables.sessionUsage
      : kind === "outputs"
        ? ctx.tables.sessionOutputs
        : ctx.tables.sessionLogs;
  if (!table) return true;
  const result = await ctx.doc.send(
    new QueryCommand({
      TableName: table,
      ConsistentRead: true,
      Limit: 25,
      KeyConditionExpression: "sessionId = :id",
      ExpressionAttributeValues: { ":id": sessionId },
    }),
  );
  const records = result.Items ?? [];
  if (records.length === 0) return true;
  const deletes = records.map((record) => ({
    DeleteRequest: {
      Key: {
        sessionId,
        [kind === "usage" ? "usageKey" : kind === "outputs" ? "recordKey" : "timestampSeq"]:
          record[kind === "usage" ? "usageKey" : kind === "outputs" ? "recordKey" : "timestampSeq"],
      },
    },
  }));
  if (kind === "usage") {
    const attempts = [...new Set(records.map((record) => record.attemptId as string))];
    const kinds = await ctx.doc.send(
      new BatchWriteCommand({
        RequestItems: {
          [ctx.tables.sessionUsageKinds]: attempts.map((attemptId) => ({
            DeleteRequest: { Key: { sessionAttempt: `${sessionId}\0${attemptId}` } },
          })),
        },
      }),
    );
    if (Object.values(kinds.UnprocessedItems ?? {}).some((items) => items.length > 0)) {
      throw new Error("session retention usage marker deletion was incomplete");
    }
  }
  const response = await ctx.doc.send(
    new BatchWriteCommand({ RequestItems: { [table]: deletes } }),
  );
  if (Object.values(response.UnprocessedItems ?? {}).some((items) => items.length > 0)) {
    throw new Error("session retention row deletion was incomplete");
  }
  return false;
}
