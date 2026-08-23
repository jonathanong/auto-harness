import {
  DescribeTableCommand,
  KeyType,
  ProjectionType,
  ResourceInUseException,
  ScalarAttributeType,
  UpdateTableCommand,
  type DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import { ScanCommand, UpdateCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

import { REPOSITORY_CATALOG_INDEX, repositoryCatalogSort } from "./plane-storage-catalog.ts";

const CATALOG_SCOPE = "repositories";
const INDEX_READY_TIMEOUT_MS = 60_000;

async function waitForCatalogIndex(client: DynamoDBClient, tableName: string): Promise<void> {
  const deadline = Date.now() + INDEX_READY_TIMEOUT_MS;
  for (;;) {
    const table = await client.send(new DescribeTableCommand({ TableName: tableName }));
    const index = table.Table?.GlobalSecondaryIndexes?.find(
      (candidate) => candidate.IndexName === REPOSITORY_CATALOG_INDEX,
    );
    // DynamoDB Local and lightweight test doubles can omit IndexStatus; a
    // real service only exposes the access path once it reports ACTIVE.
    if (index && (index.IndexStatus === undefined || index.IndexStatus === "ACTIVE")) return;
    if (Date.now() >= deadline) {
      throw new Error(`repository catalog index did not become active: ${tableName}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * Add the ordered repository catalog GSI to pre-pagination tables, then fill
 * its sparse keys for legacy rows. This is setup-time work only; endpoint
 * continuations always use the bounded GSI query in plane-storage-catalog.
 */
export async function ensureRepositoryCatalogIndex(
  client: DynamoDBClient,
  doc: DynamoDBDocumentClient,
  tableName: string,
): Promise<void> {
  let table;
  try {
    table = await client.send(new DescribeTableCommand({ TableName: tableName }));
  } catch {
    return;
  }
  let creationDeadline: number | undefined;
  while (
    !table.Table?.GlobalSecondaryIndexes?.some(
      (index) => index.IndexName === REPOSITORY_CATALOG_INDEX,
    )
  ) {
    creationDeadline ??= Date.now() + INDEX_READY_TIMEOUT_MS;
    const definitions = table.Table?.AttributeDefinitions ?? [];
    const names = new Set(definitions.map((definition) => definition.AttributeName));
    try {
      await client.send(
        new UpdateTableCommand({
          TableName: tableName,
          AttributeDefinitions: [
            ...definitions,
            ...(names.has("catalogScope")
              ? []
              : [{ AttributeName: "catalogScope", AttributeType: ScalarAttributeType.S }]),
            ...(names.has("catalogSort")
              ? []
              : [{ AttributeName: "catalogSort", AttributeType: ScalarAttributeType.S }]),
          ],
          GlobalSecondaryIndexUpdates: [
            {
              Create: {
                IndexName: REPOSITORY_CATALOG_INDEX,
                KeySchema: [
                  { AttributeName: "catalogScope", KeyType: KeyType.HASH },
                  { AttributeName: "catalogSort", KeyType: KeyType.RANGE },
                ],
                Projection: { ProjectionType: ProjectionType.ALL },
              },
            },
          ],
        }),
      );
      break;
    } catch (error) {
      if (
        error instanceof ResourceInUseException ||
        (typeof error === "object" &&
          error !== null &&
          "name" in error &&
          (error as { name?: unknown }).name === "LimitExceededException")
      ) {
        if (Date.now() >= creationDeadline) {
          throw new Error(`repository catalog index could not be created: ${tableName}`, {
            cause: error,
          });
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
        table = await client.send(new DescribeTableCommand({ TableName: tableName }));
      } else {
        throw error;
      }
    }
  }
  await waitForCatalogIndex(client, tableName);

  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await doc.send(
      new ScanCommand({
        TableName: tableName,
        ProjectionExpression: "id, #name, catalogScope, catalogSort",
        ExpressionAttributeNames: { "#name": "name" },
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }),
    );
    for (const item of page.Items ?? []) {
      const record = item as {
        id?: unknown;
        name?: unknown;
        catalogScope?: unknown;
        catalogSort?: unknown;
      };
      if (typeof record.id !== "string" || typeof record.name !== "string") continue;
      const catalogSort = repositoryCatalogSort(record.name, record.id);
      if (record.catalogScope === CATALOG_SCOPE && record.catalogSort === catalogSort) continue;
      await doc.send(
        new UpdateCommand({
          TableName: tableName,
          Key: { id: record.id },
          UpdateExpression: "SET catalogScope = :scope, catalogSort = :sort",
          ExpressionAttributeValues: { ":scope": CATALOG_SCOPE, ":sort": catalogSort },
        }),
      );
    }
    startKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (startKey && Object.keys(startKey).length > 0);
}
