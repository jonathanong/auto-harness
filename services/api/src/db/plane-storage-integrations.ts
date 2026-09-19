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
    new GetCommand({
      TableName: ctx.tables.integrations,
      Key: { id: "slack" },
      ConsistentRead: true,
    }),
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
    if (expectedVersion === null) {
      await ctx.doc.send(
        new PutCommand({
          TableName: ctx.tables.integrations,
          Item: record,
          ConditionExpression: condition,
        }),
      );
    } else {
      await ctx.doc.send(
        new UpdateCommand({
          TableName: ctx.tables.integrations,
          Key: { id: record.id },
          ConditionExpression: condition,
          ...slackIntegrationUpdate(record, expectedVersion, expectedInstallationId),
        }),
      );
    }
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

const SLACK_OPTIONAL_FIELDS = [
  "workspaceId",
  "workspaceName",
  "appId",
  "botUserId",
  "grantedScopes",
  "installationId",
] as const;

/** Updates settings-owned fields only; worker-owned delivery outcome fields stay untouched. */
function slackIntegrationUpdate(
  record: SlackIntegrationRecord,
  expectedVersion: number,
  expectedInstallationId: string | null | undefined,
): {
  UpdateExpression: string;
  ExpressionAttributeNames: Record<string, string>;
  ExpressionAttributeValues: Record<string, unknown>;
} {
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {
    ":expectedVersion": expectedVersion,
    ...(typeof expectedInstallationId === "string"
      ? { ":expectedInstallationId": expectedInstallationId }
      : {}),
  };
  const set: string[] = [];
  const remove: string[] = [];
  for (const [field, value] of Object.entries(record)) {
    if (field === "id" || field === "lastDeliveryFailure" || field === "lastDeliveryOutcomeAt")
      continue;
    names[`#${field}`] = field;
    values[`:${field}`] = value;
    set.push(`#${field} = :${field}`);
  }
  for (const field of SLACK_OPTIONAL_FIELDS) {
    if (field in record) continue;
    names[`#${field}`] = field;
    remove.push(`#${field}`);
  }
  return {
    UpdateExpression: `SET ${set.join(", ")}${remove.length ? ` REMOVE ${remove.join(", ")}` : ""}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  };
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
 * Narrow, version-independent update: it neither reads nor bumps `version`, and its
 * monotonic timestamp fence prevents a delayed older outcome from replacing a newer one.
 */
export async function recordSlackDeliveryOutcome(
  ctx: PlaneStorageCtx,
  outcome: SlackDeliveryOutcome,
): Promise<void> {
  try {
    const installationCondition =
      outcome.installationId === null
        ? "attribute_not_exists(installationId)"
        : "installationId = :installationId";
    await ctx.doc.send(
      new UpdateCommand({
        TableName: ctx.tables.integrations,
        Key: { id: "slack" },
        ConditionExpression: outcome.ok
          ? `attribute_exists(id) AND ${installationCondition} AND (attribute_not_exists(lastDeliveryOutcomeAt) OR lastDeliveryOutcomeAt < :at OR (lastDeliveryOutcomeAt = :at AND attribute_exists(lastDeliveryFailure)))`
          : `attribute_exists(id) AND ${installationCondition} AND (attribute_not_exists(lastDeliveryOutcomeAt) OR lastDeliveryOutcomeAt < :at)`,
        ...(outcome.ok
          ? {
              UpdateExpression: "SET lastDeliveryOutcomeAt = :at REMOVE lastDeliveryFailure",
              ExpressionAttributeValues: {
                ":at": outcome.at,
                ...(outcome.installationId === null
                  ? {}
                  : { ":installationId": outcome.installationId }),
              },
            }
          : {
              UpdateExpression: "SET lastDeliveryFailure = :failure, lastDeliveryOutcomeAt = :at",
              ExpressionAttributeValues: {
                ":at": outcome.at,
                ":failure": { message: outcome.error, at: outcome.at },
                ...(outcome.installationId === null
                  ? {}
                  : { ":installationId": outcome.installationId }),
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
