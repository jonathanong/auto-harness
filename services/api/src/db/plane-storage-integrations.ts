import { DeleteCommand, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";

import type { SlackIntegrationRecord } from "../slack-integration-types.ts";
import type { PlaneStorageCtx } from "./plane-storage-types.ts";

export async function getSlackIntegration(
  ctx: PlaneStorageCtx,
): Promise<SlackIntegrationRecord | null> {
  const response = await ctx.doc.send(
    new GetCommand({ TableName: ctx.tables.integrations, Key: { id: "slack" } }),
  );
  return (response.Item as SlackIntegrationRecord | undefined) ?? null;
}

/** CAS writes stop an older API worker from overwriting a newer integration config. */
export async function putSlackIntegration(
  ctx: PlaneStorageCtx,
  record: SlackIntegrationRecord,
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
    if (
      typeof error === "object" &&
      error !== null &&
      "name" in error &&
      (error as { name?: string }).name === "ConditionalCheckFailedException"
    ) {
      return false;
    }
    throw error;
  }
}

export async function deleteSlackIntegration(
  ctx: PlaneStorageCtx,
  expectedVersion: number,
): Promise<boolean> {
  try {
    await ctx.doc.send(
      new DeleteCommand({
        TableName: ctx.tables.integrations,
        Key: { id: "slack" },
        ConditionExpression: "attribute_exists(id) AND version = :expectedVersion",
        ExpressionAttributeValues: { ":expectedVersion": expectedVersion },
      }),
    );
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "name" in error &&
      (error as { name?: string }).name === "ConditionalCheckFailedException"
    ) {
      return false;
    }
    throw error;
  }
}
