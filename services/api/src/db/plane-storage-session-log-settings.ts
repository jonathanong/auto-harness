import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { SESSION_LOG_SETTINGS_ID } from "@auto-harness/shared";

import type { PlaneStorageCtx, SessionLogSettingsRecord } from "./plane-storage-types.ts";
import { isConditionalTransactionFailed } from "./plane-storage-types.ts";

export async function getSessionLogSettings(
  ctx: PlaneStorageCtx,
): Promise<SessionLogSettingsRecord | null> {
  const response = await ctx.doc.send(
    new GetCommand({
      TableName: ctx.tables.integrations,
      Key: { id: SESSION_LOG_SETTINGS_ID },
      ConsistentRead: true,
    }),
  );
  const item = response.Item as SessionLogSettingsRecord | undefined;
  return item?.type === SESSION_LOG_SETTINGS_ID ? item : null;
}

export async function putSessionLogSettings(
  ctx: PlaneStorageCtx,
  record: SessionLogSettingsRecord,
  expectedVersion: number | null,
): Promise<boolean> {
  try {
    await ctx.doc.send(
      new PutCommand({
        TableName: ctx.tables.integrations,
        Item: record,
        ConditionExpression:
          expectedVersion === null
            ? "attribute_not_exists(id)"
            : "attribute_exists(id) AND version = :expectedVersion",
        ...(expectedVersion === null
          ? {}
          : { ExpressionAttributeValues: { ":expectedVersion": expectedVersion } }),
      }),
    );
    return true;
  } catch (error) {
    if (isConditionalFailure(error) || isConditionalTransactionFailed(error)) return false;
    throw error;
  }
}

function isConditionalFailure(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name: string }).name === "ConditionalCheckFailedException"
  );
}
