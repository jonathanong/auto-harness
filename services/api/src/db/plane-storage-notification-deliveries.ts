import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

import type { SlackDeliveryRecord, SlackOutboxStore } from "../slack-delivery-types.ts";
import { isConditionalFailed, type PlaneStorageCtx } from "./plane-storage-types.ts";

const dueIndex = "status-nextAttemptAt";

export async function enqueue(
  ctx: PlaneStorageCtx,
  record: SlackDeliveryRecord,
): Promise<"created" | "exists"> {
  try {
    await ctx.doc.send(
      new PutCommand({
        TableName: ctx.tables.notificationDeliveries,
        Item: record,
        ConditionExpression: "attribute_not_exists(id)",
      }),
    );
    return "created";
  } catch (error) {
    if (isConditionalFailed(error)) return "exists";
    throw error;
  }
}

export async function get(ctx: PlaneStorageCtx, id: string): Promise<SlackDeliveryRecord | null> {
  const result = await ctx.doc.send(
    new GetCommand({
      TableName: ctx.tables.notificationDeliveries,
      Key: { id },
      ConsistentRead: true,
    }),
  );
  return (result.Item as SlackDeliveryRecord | undefined) ?? null;
}

export async function claimDue(
  ctx: PlaneStorageCtx,
  input: Parameters<SlackOutboxStore["claimDue"]>[0],
): Promise<SlackDeliveryRecord | null> {
  for (const status of ["pending", "delivering"] as const) {
    const result = await ctx.doc.send(
      new QueryCommand({
        TableName: ctx.tables.notificationDeliveries,
        IndexName: dueIndex,
        KeyConditionExpression: "#status = :status AND nextAttemptAt <= :now",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":status": status, ":now": input.now },
        Limit: 20,
      }),
    );
    for (const candidate of (result.Items ?? []) as SlackDeliveryRecord[]) {
      const claimed = await claim(ctx, candidate.id, status, input);
      if (claimed) return claimed;
    }
  }
  return null;
}

async function claim(
  ctx: PlaneStorageCtx,
  id: string,
  status: "pending" | "delivering",
  input: Parameters<SlackOutboxStore["claimDue"]>[0],
): Promise<SlackDeliveryRecord | null> {
  try {
    const result = await ctx.doc.send(
      new UpdateCommand({
        TableName: ctx.tables.notificationDeliveries,
        Key: { id },
        ConditionExpression: "#status = :expected AND nextAttemptAt <= :now",
        UpdateExpression:
          "SET #status = :delivering, leaseToken = :token, leaseExpiresAt = :expires, nextAttemptAt = :expires, updatedAt = :now",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":expected": status,
          ":delivering": "delivering",
          ":token": input.leaseToken,
          ":expires": input.leaseExpiresAt,
          ":now": input.now,
        },
        ReturnValues: "ALL_NEW",
      }),
    );
    return (result.Attributes as SlackDeliveryRecord | undefined) ?? null;
  } catch (error) {
    if (isConditionalFailed(error)) return null;
    throw error;
  }
}

export async function complete(
  ctx: PlaneStorageCtx,
  input: Parameters<SlackOutboxStore["complete"]>[0],
): Promise<boolean> {
  return updateClaimed(ctx, input.id, input.leaseToken, {
    update:
      "SET #status = :status, remoteChannel = :channel, remoteMessageTs = :messageTs, updatedAt = :now REMOVE leaseToken, leaseExpiresAt, lastError",
    values: {
      ":status": "sent",
      ":channel": input.result.channel,
      ":messageTs": input.result.messageTs,
      ":now": input.now,
    },
  });
}

export async function reschedule(
  ctx: PlaneStorageCtx,
  input: Parameters<SlackOutboxStore["reschedule"]>[0],
): Promise<boolean> {
  return updateClaimed(ctx, input.id, input.leaseToken, {
    update:
      "SET #status = :status, attempts = :attempts, nextAttemptAt = :nextAttemptAt, lastError = :error, updatedAt = :now REMOVE leaseToken, leaseExpiresAt",
    values: {
      ":status": input.status,
      ":attempts": input.attempts,
      ":nextAttemptAt": input.nextAttemptAt,
      ":error": input.error,
      ":now": input.now,
    },
  });
}

async function updateClaimed(
  ctx: PlaneStorageCtx,
  id: string,
  leaseToken: string,
  change: { update: string; values: Record<string, unknown> },
): Promise<boolean> {
  try {
    await ctx.doc.send(
      new UpdateCommand({
        TableName: ctx.tables.notificationDeliveries,
        Key: { id },
        ConditionExpression: "#status = :delivering AND leaseToken = :token",
        UpdateExpression: change.update,
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ...change.values,
          ":delivering": "delivering",
          ":token": leaseToken,
        },
      }),
    );
    return true;
  } catch (error) {
    if (isConditionalFailed(error)) return false;
    throw error;
  }
}
