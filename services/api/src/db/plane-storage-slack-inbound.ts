import { DeleteCommand, PutCommand } from "@aws-sdk/lib-dynamodb";

import type { SlackInboundEventRecord, SlackOAuthStateRecord } from "../slack-oauth-types.ts";
import type { PlaneStorageCtx } from "./plane-storage-types.ts";

export async function putSlackOAuthState(
  ctx: PlaneStorageCtx,
  record: SlackOAuthStateRecord,
): Promise<boolean> {
  try {
    await ctx.doc.send(
      new PutCommand({
        TableName: ctx.tables.slackOAuthStates,
        Item: record,
        ConditionExpression: "attribute_not_exists(stateHash)",
      }),
    );
    return true;
  } catch (error) {
    if (isConditional(error)) return false;
    throw error;
  }
}

/** Delete-return is a one-time consume fence: concurrent callbacks cannot both use the state. */
export async function consumeSlackOAuthState(
  ctx: PlaneStorageCtx,
  stateHash: string,
  nowSeconds: number,
): Promise<SlackOAuthStateRecord | null> {
  try {
    const response = await ctx.doc.send(
      new DeleteCommand({
        TableName: ctx.tables.slackOAuthStates,
        Key: { stateHash },
        ConditionExpression: "expiresAt > :now",
        ExpressionAttributeValues: { ":now": nowSeconds },
        ReturnValues: "ALL_OLD",
      }),
    );
    return (response.Attributes as SlackOAuthStateRecord | undefined) ?? null;
  } catch (error) {
    if (isConditional(error)) return null;
    throw error;
  }
}

export async function putSlackInboundEvent(
  ctx: PlaneStorageCtx,
  record: SlackInboundEventRecord,
): Promise<boolean> {
  try {
    await ctx.doc.send(
      new PutCommand({
        TableName: ctx.tables.slackInboundEvents,
        Item: record,
        ConditionExpression: "attribute_not_exists(workspaceId) AND attribute_not_exists(eventId)",
      }),
    );
    return true;
  } catch (error) {
    if (isConditional(error)) return false;
    throw error;
  }
}

function isConditional(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: string }).name === "ConditionalCheckFailedException"
  );
}
