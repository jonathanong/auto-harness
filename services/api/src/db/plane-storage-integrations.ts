/* eslint-disable max-lines -- integration CAS and deletion-marker write fence stay co-located. */
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

import type { SlackDeliveryOutcome, SlackIntegrationRecord } from "../slack-integration-types.ts";
import type { CustomWebhookIntegrationRecord, PlaneStorageCtx } from "./plane-storage-types.ts";
import { isConditionalTransactionFailed, nextPageKey } from "./plane-storage-types.ts";
import { ownedWrite, type OwnedDeletionMarker } from "./plane-storage-deletion-markers.ts";

export async function getSlackIntegration(
  ctx: PlaneStorageCtx,
): Promise<SlackIntegrationRecord | null> {
  const response = await ctx.doc.send(
    new GetCommand({ TableName: ctx.tables.integrations, Key: { id: "slack" } }),
  );
  return (response.Item as SlackIntegrationRecord | undefined) ?? null;
}
export async function putSlackIntegration(
  ctx: PlaneStorageCtx,
  record: SlackIntegrationRecord,
  expectedVersion: number | null,
  expectedInstallationId?: string | null,
): Promise<boolean> {
  try {
    const condition =
      expectedVersion === null
        ? "attribute_not_exists(id)"
        : [
            "attribute_exists(id)",
            "version = :expectedVersion",
            ...(expectedInstallationId === undefined
              ? []
              : [
                  expectedInstallationId === null
                    ? "attribute_not_exists(installationId)"
                    : "installationId = :expectedInstallationId",
                ]),
          ].join(" AND ");
    await ctx.doc.send(
      new PutCommand({
        TableName: ctx.tables.integrations,
        Item: record,
        ConditionExpression: condition,
        ...(expectedVersion === null
          ? {}
          : {
              ExpressionAttributeValues: {
                ":expectedVersion": expectedVersion,
                ...(expectedInstallationId === undefined || expectedInstallationId === null
                  ? {}
                  : { ":expectedInstallationId": expectedInstallationId }),
              },
            }),
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
/**
 * Narrow, version-independent update: it neither reads nor bumps `version`, so it never
 * races or conflicts with a concurrent settings-form CAS write through
 * `putSlackIntegration`. A missing row (integration deleted) or, on success, nothing to
 * clear both fail the condition and are treated as a no-op rather than an error.
 */
export async function recordSlackDeliveryOutcome(
  ctx: PlaneStorageCtx,
  outcome: SlackDeliveryOutcome,
): Promise<void> {
  try {
    await ctx.doc.send(
      new UpdateCommand({
        TableName: ctx.tables.integrations,
        Key: { id: "slack" },
        ConditionExpression: outcome.ok
          ? "attribute_exists(id) AND attribute_exists(lastDeliveryFailure)"
          : "attribute_exists(id)",
        ...(outcome.ok
          ? { UpdateExpression: "REMOVE lastDeliveryFailure" }
          : {
              UpdateExpression: "SET lastDeliveryFailure = :failure",
              ExpressionAttributeValues: {
                ":failure": { message: outcome.error, at: outcome.at },
              },
            }),
      }),
    );
  } catch (error) {
    if (!isConditionalFailure(error)) throw error;
  }
}

export async function getCustomWebhookIntegration(
  ctx: PlaneStorageCtx,
  id: string,
): Promise<CustomWebhookIntegrationRecord | null> {
  const response = await ctx.doc.send(
    new GetCommand({
      TableName: ctx.tables.integrations,
      Key: { id: customWebhookStorageId(id) },
      ConsistentRead: true,
    }),
  );
  const item = response.Item as CustomWebhookIntegrationRecord | undefined;
  return item?.type === "custom-webhook" ? { ...item, id } : null;
}

export async function listCustomWebhookIntegrations(
  ctx: PlaneStorageCtx,
): Promise<CustomWebhookIntegrationRecord[]> {
  const records: CustomWebhookIntegrationRecord[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const response = await ctx.doc.send(
      new ScanCommand({
        TableName: ctx.tables.integrations,
        ConsistentRead: true,
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }),
    );
    for (const item of (response.Items as CustomWebhookIntegrationRecord[] | undefined) ?? []) {
      if (item.type !== "custom-webhook" || typeof item.id !== "string") continue;
      const id = customWebhookIdFromStorageId(item.id);
      if (!id) continue;
      records.push({ ...item, id });
    }
    startKey = nextPageKey(response.LastEvaluatedKey as Record<string, unknown> | undefined);
  } while (startKey);
  return records;
}

export async function putCustomWebhookIntegration(
  ctx: PlaneStorageCtx,
  record: CustomWebhookIntegrationRecord,
  expectedVersion: number | null,
  markers?: readonly OwnedDeletionMarker[],
  expectedGeneration?: string | null,
): Promise<boolean> {
  try {
    const put = {
      TableName: ctx.tables.integrations,
      Item: { ...record, id: customWebhookStorageId(record.id) },
      ConditionExpression:
        expectedVersion === null
          ? "attribute_not_exists(id)"
          : `attribute_exists(id) AND version = :expectedVersion${
              expectedGeneration === undefined ? "" : " AND #generation = :expectedGeneration"
            }`,
      ...(expectedVersion === null
        ? {}
        : {
            ...(expectedGeneration === undefined
              ? {}
              : { ExpressionAttributeNames: { "#generation": "generation" } }),
            ExpressionAttributeValues: {
              ":expectedVersion": expectedVersion,
              ...(typeof expectedGeneration === "string"
                ? { ":expectedGeneration": expectedGeneration }
                : {}),
            },
          }),
    };
    if (markers?.length) await ownedWrite(ctx, markers, { Put: put });
    else await ctx.doc.send(new PutCommand(put));
    return true;
  } catch (error) {
    if (isConditionalFailure(error) || isConditionalTransactionFailed(error)) return false;
    throw error;
  }
}

export async function deleteCustomWebhookIntegration(
  ctx: PlaneStorageCtx,
  id: string,
  expectedVersion: number,
  expectedGeneration?: string | null,
): Promise<boolean> {
  try {
    await ctx.doc.send(
      new DeleteCommand({
        TableName: ctx.tables.integrations,
        Key: { id: customWebhookStorageId(id) },
        ConditionExpression: `attribute_exists(id) AND version = :expectedVersion${
          expectedGeneration === undefined ? "" : " AND #generation = :expectedGeneration"
        }`,
        ...(expectedGeneration === undefined
          ? {}
          : { ExpressionAttributeNames: { "#generation": "generation" } }),
        ExpressionAttributeValues: {
          ":expectedVersion": expectedVersion,
          ...(typeof expectedGeneration === "string"
            ? { ":expectedGeneration": expectedGeneration }
            : {}),
        },
      }),
    );
    return true;
  } catch (error) {
    if (isConditionalFailure(error)) return false;
    throw error;
  }
}

export function customWebhookStorageId(id: string): string {
  return `custom-webhook:${id}`;
}

function customWebhookIdFromStorageId(storageId: string): string | null {
  const prefix = "custom-webhook:";
  return storageId.startsWith(prefix) && storageId.length > prefix.length
    ? storageId.slice(prefix.length)
    : null;
}

function isConditionalFailure(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: string }).name === "ConditionalCheckFailedException"
  );
}
