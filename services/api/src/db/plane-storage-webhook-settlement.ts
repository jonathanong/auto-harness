import { UpdateCommand } from "@aws-sdk/lib-dynamodb";

import {
  assertCanonicalTimestamp,
  assertWebhookFailureCode,
  type WebhookFailureCode,
} from "../webhook-outbox.ts";
import { isConditionalFailed, type PlaneStorageCtx } from "./plane-storage-types.ts";
import type { WebhookLeaseFence } from "./plane-storage-webhook-outbox.ts";

function assertNonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) throw new TypeError(`${label} must not be empty`);
}

function assertFence(input: WebhookLeaseFence): void {
  assertNonEmpty(input.id, "id");
  assertNonEmpty(input.owner, "owner");
  assertNonEmpty(input.leaseId, "leaseId");
  assertCanonicalTimestamp(input.now, "now");
}

export async function completeWebhookDelivery(
  ctx: PlaneStorageCtx,
  input: WebhookLeaseFence,
): Promise<boolean> {
  assertFence(input);
  try {
    await ctx.doc.send(
      new UpdateCommand({
        TableName: ctx.tables.webhookDeliveries,
        Key: { id: input.id },
        UpdateExpression:
          "SET #state = :delivered, updatedAt = :now, deliveredAt = :now REMOVE dueAt, leaseOwner, leaseId, leaseExpiresAt",
        ConditionExpression:
          "#state = :leased AND leaseOwner = :owner AND leaseId = :leaseId AND leaseExpiresAt > :now",
        ExpressionAttributeNames: { "#state": "state" },
        ExpressionAttributeValues: {
          ":leased": "leased",
          ":delivered": "delivered",
          ":owner": input.owner,
          ":leaseId": input.leaseId,
          ":now": input.now,
        },
      }),
    );
    return true;
  } catch (error) {
    if (isConditionalFailed(error)) return false;
    throw error;
  }
}

async function settleFailure(
  ctx: PlaneStorageCtx,
  input: WebhookLeaseFence & { failureCode: WebhookFailureCode; nextAttemptAt: string },
  state: "pending" | "dead",
): Promise<boolean> {
  try {
    await ctx.doc.send(
      new UpdateCommand({
        TableName: ctx.tables.webhookDeliveries,
        Key: { id: input.id },
        UpdateExpression:
          state === "pending"
            ? "SET #state = :state, dueAt = :next, updatedAt = :now, lastFailedAt = :now, lastFailureCode = :failure REMOVE leaseOwner, leaseId, leaseExpiresAt"
            : "SET #state = :state, updatedAt = :now, deadLetteredAt = :now, lastFailedAt = :now, lastFailureCode = :failure REMOVE dueAt, leaseOwner, leaseId, leaseExpiresAt",
        ConditionExpression:
          "#state = :leased AND leaseOwner = :owner AND leaseId = :leaseId AND leaseExpiresAt > :now AND " +
          (state === "pending" ? "attemptCount < maxAttempts" : "attemptCount >= maxAttempts"),
        ExpressionAttributeNames: { "#state": "state" },
        ExpressionAttributeValues: {
          ":leased": "leased",
          ":state": state,
          ":owner": input.owner,
          ":leaseId": input.leaseId,
          ":now": input.now,
          ":failure": input.failureCode,
          ...(state === "pending" ? { ":next": input.nextAttemptAt } : {}),
        },
      }),
    );
    return true;
  } catch (error) {
    if (isConditionalFailed(error)) return false;
    throw error;
  }
}

/** A failed final attempt moves directly to the dead letter state. */
export async function failWebhookDelivery(
  ctx: PlaneStorageCtx,
  input: WebhookLeaseFence & { failureCode: WebhookFailureCode; nextAttemptAt: string },
): Promise<"pending" | "dead" | null> {
  assertFence(input);
  assertWebhookFailureCode(input.failureCode);
  assertCanonicalTimestamp(input.nextAttemptAt, "nextAttemptAt");
  if (input.nextAttemptAt <= input.now) {
    throw new RangeError("nextAttemptAt must be after now");
  }
  if (await settleFailure(ctx, input, "pending")) return "pending";
  if (await settleFailure(ctx, input, "dead")) return "dead";
  return null;
}

/** Recover an exhausted due row whose last worker vanished before settlement. */
export async function deadLetterExhaustedWebhookDelivery(
  ctx: PlaneStorageCtx,
  input: { id: string; now: string },
): Promise<boolean> {
  assertNonEmpty(input.id, "id");
  assertCanonicalTimestamp(input.now, "now");
  try {
    await ctx.doc.send(
      new UpdateCommand({
        TableName: ctx.tables.webhookDeliveries,
        Key: { id: input.id },
        UpdateExpression:
          "SET #state = :dead, updatedAt = :now, deadLetteredAt = :now, lastFailedAt = :now, lastFailureCode = :failure REMOVE dueAt, leaseOwner, leaseId, leaseExpiresAt",
        ConditionExpression:
          "(#state = :pending OR #state = :leased) AND dueAt <= :now AND attemptCount >= maxAttempts",
        ExpressionAttributeNames: { "#state": "state" },
        ExpressionAttributeValues: {
          ":pending": "pending",
          ":leased": "leased",
          ":dead": "dead",
          ":now": input.now,
          ":failure": "lease-expired",
        },
      }),
    );
    return true;
  } catch (error) {
    if (isConditionalFailed(error)) return false;
    throw error;
  }
}
