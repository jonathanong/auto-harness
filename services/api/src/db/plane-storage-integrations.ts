import { DeleteCommand, GetCommand, PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";

import type { SlackIntegrationRecord } from "../slack-integration-types.ts";
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

/** Compare-and-swap prevents a stale worker from replacing a newer config. */
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

/** Strongly read every custom integration before a catalog dependency delete. */
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

/** Compare-and-swap protects rotation and deletion from stale operator tabs. */
export async function putCustomWebhookIntegration(
  ctx: PlaneStorageCtx,
  record: CustomWebhookIntegrationRecord,
  expectedVersion: number | null,
  markers?: readonly OwnedDeletionMarker[],
): Promise<boolean> {
  try {
    const put = {
      TableName: ctx.tables.integrations,
      Item: { ...record, id: customWebhookStorageId(record.id) },
      ConditionExpression:
        expectedVersion === null
          ? "attribute_not_exists(id)"
          : "attribute_exists(id) AND version = :expectedVersion",
      ...(expectedVersion === null
        ? {}
        : { ExpressionAttributeValues: { ":expectedVersion": expectedVersion } }),
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
): Promise<boolean> {
  try {
    await ctx.doc.send(
      new DeleteCommand({
        TableName: ctx.tables.integrations,
        Key: { id: customWebhookStorageId(id) },
        ConditionExpression: "attribute_exists(id) AND version = :expectedVersion",
        ExpressionAttributeValues: { ":expectedVersion": expectedVersion },
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
