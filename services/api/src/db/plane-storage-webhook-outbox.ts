import {
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

import {
  assertCanonicalTimestamp,
  assertWebhookQueryLimit,
  createWebhookDelivery,
  type DurableWebhookDelivery,
  type WebhookEnqueueInput,
} from "../webhook-outbox.ts";
import { isConditionalFailed, type PlaneStorageCtx } from "./plane-storage-types.ts";

export type WebhookLeaseInput = {
  id: string;
  owner: string;
  leaseId: string;
  now: string;
  leaseExpiresAt: string;
};

export type WebhookLeaseFence = {
  id: string;
  owner: string;
  leaseId: string;
  now: string;
};

function delivery(item: Record<string, unknown>): DurableWebhookDelivery {
  return item as unknown as DurableWebhookDelivery;
}

function assertNonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) throw new TypeError(`${label} must not be empty`);
}

function assertFence(input: WebhookLeaseFence): void {
  assertNonEmpty(input.id, "id");
  assertNonEmpty(input.owner, "owner");
  assertNonEmpty(input.leaseId, "leaseId");
  assertCanonicalTimestamp(input.now, "now");
}

export async function enqueueWebhookDelivery(
  ctx: PlaneStorageCtx,
  input: WebhookEnqueueInput,
): Promise<{ created: boolean; delivery: DurableWebhookDelivery }> {
  const record = createWebhookDelivery(input);
  try {
    await ctx.doc.send(
      new PutCommand({
        TableName: ctx.tables.webhookDeliveries,
        Item: record,
        ConditionExpression: "attribute_not_exists(id)",
      }),
    );
    return { created: true, delivery: record };
  } catch (error) {
    if (isConditionalFailed(error)) {
      const existing = await getWebhookDelivery(ctx, record.id);
      if (existing) return { created: false, delivery: existing };
    }
    throw error;
  }
}

export async function getWebhookDelivery(
  ctx: PlaneStorageCtx,
  id: string,
): Promise<DurableWebhookDelivery | null> {
  const response = await ctx.doc.send(
    new GetCommand({
      TableName: ctx.tables.webhookDeliveries,
      Key: { id },
      ConsistentRead: true,
    }),
  );
  return response.Item ? delivery(response.Item) : null;
}

/** Bounded queue read. Pending rows use retry time; leased rows use lease expiry as `dueAt`. */
export async function listDueWebhookDeliveries(
  ctx: PlaneStorageCtx,
  input: { state: "pending" | "leased"; now: string; limit: number },
): Promise<DurableWebhookDelivery[]> {
  assertCanonicalTimestamp(input.now, "now");
  assertWebhookQueryLimit(input.limit);
  const response = await ctx.doc.send(
    new QueryCommand({
      TableName: ctx.tables.webhookDeliveries,
      IndexName: "state-dueAt",
      KeyConditionExpression: "#state = :state AND dueAt <= :now",
      ExpressionAttributeNames: { "#state": "state" },
      ExpressionAttributeValues: { ":state": input.state, ":now": input.now },
      Limit: input.limit,
      ScanIndexForward: true,
    }),
  );
  return (response.Items ?? []).map(delivery);
}

export async function claimWebhookDelivery(
  ctx: PlaneStorageCtx,
  input: WebhookLeaseInput,
): Promise<DurableWebhookDelivery | null> {
  assertFence(input);
  assertCanonicalTimestamp(input.leaseExpiresAt, "leaseExpiresAt");
  if (input.leaseExpiresAt <= input.now) {
    throw new RangeError("leaseExpiresAt must be after now");
  }
  try {
    const response = await ctx.doc.send(
      new UpdateCommand({
        TableName: ctx.tables.webhookDeliveries,
        Key: { id: input.id },
        UpdateExpression:
          "SET #state = :leased, dueAt = :expiry, updatedAt = :now, leaseOwner = :owner, leaseId = :leaseId, leaseExpiresAt = :expiry, attemptCount = attemptCount + :one",
        ConditionExpression:
          "(#state = :pending OR #state = :leased) AND dueAt <= :now AND attemptCount < maxAttempts",
        ExpressionAttributeNames: { "#state": "state" },
        ExpressionAttributeValues: {
          ":pending": "pending",
          ":leased": "leased",
          ":now": input.now,
          ":owner": input.owner,
          ":leaseId": input.leaseId,
          ":expiry": input.leaseExpiresAt,
          ":one": 1,
        },
        ReturnValues: "ALL_NEW",
      }),
    );
    return response.Attributes ? delivery(response.Attributes) : null;
  } catch (error) {
    if (isConditionalFailed(error)) return null;
    throw error;
  }
}

/** Test cleanup only; runtime queue consumption must use the bounded GSI query. */
export async function listAllWebhookDeliveries(
  ctx: PlaneStorageCtx,
): Promise<DurableWebhookDelivery[]> {
  const records: DurableWebhookDelivery[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const response = await ctx.doc.send(
      new ScanCommand({
        TableName: ctx.tables.webhookDeliveries,
        ExclusiveStartKey: startKey,
      }),
    );
    records.push(...(response.Items ?? []).map(delivery));
    startKey = response.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (startKey);
  return records;
}
