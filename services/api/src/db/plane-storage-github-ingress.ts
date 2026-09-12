import { DeleteCommand, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";

import type { GitHubIngressConfigRecord, PlaneStorageCtx } from "./plane-storage-types.ts";
import { isConditionalTransactionFailed } from "./plane-storage-types.ts";
import { ownedWrite, type OwnedDeletionMarker } from "./plane-storage-deletion-markers.ts";

export async function getGitHubIngressConfig(
  ctx: PlaneStorageCtx,
): Promise<GitHubIngressConfigRecord | null> {
  const response = await ctx.doc.send(
    new GetCommand({
      TableName: ctx.tables.integrations,
      Key: { id: "github-ingress" },
      ConsistentRead: true,
    }),
  );
  const item = response.Item as GitHubIngressConfigRecord | undefined;
  return item?.type === "github-ingress" ? item : null;
}

export async function putGitHubIngressConfig(
  ctx: PlaneStorageCtx,
  record: GitHubIngressConfigRecord,
  expectedVersion: number | null,
  markers?: readonly OwnedDeletionMarker[],
  expectedGeneration?: string | null,
): Promise<boolean> {
  try {
    const put = {
      TableName: ctx.tables.integrations,
      Item: record,
      ConditionExpression:
        expectedVersion === null
          ? "attribute_not_exists(id)"
          : `attribute_exists(id) AND version = :expectedVersion${
              expectedGeneration === undefined
                ? ""
                : expectedGeneration === null
                  ? " AND attribute_not_exists(#generation)"
                  : " AND #generation = :expectedGeneration"
            }`,
      ...(expectedVersion === null
        ? {}
        : {
            ExpressionAttributeValues: {
              ":expectedVersion": expectedVersion,
              ...(typeof expectedGeneration === "string"
                ? { ":expectedGeneration": expectedGeneration }
                : {}),
            },
            ...(expectedGeneration === undefined
              ? {}
              : { ExpressionAttributeNames: { "#generation": "generation" } }),
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

export async function deleteGitHubIngressConfig(
  ctx: PlaneStorageCtx,
  expectedVersion: number,
  expectedGeneration?: string | null,
): Promise<boolean> {
  try {
    await ctx.doc.send(
      new DeleteCommand({
        TableName: ctx.tables.integrations,
        Key: { id: "github-ingress" },
        ConditionExpression: `attribute_exists(id) AND version = :expectedVersion${
          expectedGeneration === undefined
            ? ""
            : expectedGeneration === null
              ? " AND attribute_not_exists(#generation)"
              : " AND #generation = :expectedGeneration"
        }`,
        ExpressionAttributeValues: {
          ":expectedVersion": expectedVersion,
          ...(typeof expectedGeneration === "string"
            ? { ":expectedGeneration": expectedGeneration }
            : {}),
        },
        ...(expectedGeneration === undefined
          ? {}
          : { ExpressionAttributeNames: { "#generation": "generation" } }),
      }),
    );
    return true;
  } catch (error) {
    if (isConditionalFailure(error)) return false;
    throw error;
  }
}

function isConditionalFailure(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: string }).name === "ConditionalCheckFailedException"
  );
}
