import {
  DescribeTableCommand,
  KeyType,
  ProjectionType,
  ResourceInUseException,
  ScalarAttributeType,
  UpdateTableCommand,
  type AttributeDefinition,
  type DescribeTableCommandOutput,
  type DynamoDBClient,
  type UpdateTableCommandInput,
} from "@aws-sdk/client-dynamodb";
import { ScanCommand, UpdateCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

import { REPOSITORY_CATALOG_INDEX, repositoryCatalogSort } from "./plane-storage-catalog.ts";

const CATALOG_SCOPE = "repositories";
const INDEX_READY_TIMEOUT_MS = 60_000;

type CatalogTable = DescribeTableCommandOutput;

type CatalogItem = {
  id?: unknown;
  name?: unknown;
  catalogScope?: unknown;
  catalogSort?: unknown;
};

type CatalogScanPage = {
  Items?: ReadonlyArray<Record<string, unknown>>;
  LastEvaluatedKey?: Record<string, unknown>;
};

const hasCatalogIndex = (table: CatalogTable): boolean =>
  table.Table?.GlobalSecondaryIndexes?.some(
    (index) => index.IndexName === REPOSITORY_CATALOG_INDEX,
  ) ?? false;

const isCatalogIndexActive = (table: CatalogTable): boolean => {
  const index = table.Table?.GlobalSecondaryIndexes?.find(
    (candidate) => candidate.IndexName === REPOSITORY_CATALOG_INDEX,
  );
  return Boolean(index && (index.IndexStatus === undefined || index.IndexStatus === "ACTIVE"));
};

const hasStartKey = (startKey: Record<string, unknown> | undefined): boolean =>
  Boolean(startKey && Object.keys(startKey).length > 0);

const delay = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 100));
};

async function describeCatalogTable(
  client: DynamoDBClient,
  tableName: string,
): Promise<CatalogTable> {
  return (await client.send(new DescribeTableCommand({ TableName: tableName }))) as CatalogTable;
}

async function waitForCatalogIndex(client: DynamoDBClient, tableName: string): Promise<void> {
  const deadline = Date.now() + INDEX_READY_TIMEOUT_MS;
  for (;;) {
    const table = await describeCatalogTable(client, tableName);
    // DynamoDB Local and lightweight test doubles can omit IndexStatus; a
    // real service only exposes the access path once it reports ACTIVE.
    if (isCatalogIndexActive(table)) return;
    if (Date.now() >= deadline) {
      throw new Error(`repository catalog index did not become active: ${tableName}`);
    }
    await delay();
  }
}

const isConcurrentIndexUpdate = (error: unknown): boolean =>
  error instanceof ResourceInUseException ||
  (typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: unknown }).name === "LimitExceededException");

const indexUpdateInput = (
  tableName: string,
  definitions: ReadonlyArray<AttributeDefinition>,
): UpdateTableCommandInput => {
  const names = new Set(definitions.map((definition) => definition.AttributeName));
  return {
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
  };
};

async function ensureCatalogIndex(
  client: DynamoDBClient,
  tableName: string,
  initial: CatalogTable,
) {
  let table = initial;
  let creationDeadline: number | undefined;
  while (!hasCatalogIndex(table)) {
    creationDeadline ??= Date.now() + INDEX_READY_TIMEOUT_MS;
    try {
      await client.send(
        new UpdateTableCommand({
          ...indexUpdateInput(tableName, table.Table?.AttributeDefinitions ?? []),
        }),
      );
      break;
    } catch (error) {
      if (!isConcurrentIndexUpdate(error)) throw error;
      if (Date.now() >= creationDeadline) {
        throw new Error(`repository catalog index could not be created: ${tableName}`, {
          cause: error,
        });
      }
      await delay();
      table = await describeCatalogTable(client, tableName);
    }
  }
  await waitForCatalogIndex(client, tableName);
}

async function backfillCatalogItem(
  doc: DynamoDBDocumentClient,
  tableName: string,
  item: CatalogItem,
): Promise<void> {
  if (typeof item.id !== "string" || typeof item.name !== "string") return;
  const catalogSort = repositoryCatalogSort(item.name, item.id);
  if (item.catalogScope === CATALOG_SCOPE && item.catalogSort === catalogSort) return;
  await doc.send(
    new UpdateCommand({
      TableName: tableName,
      Key: { id: item.id },
      UpdateExpression: "SET catalogScope = :scope, catalogSort = :sort",
      ExpressionAttributeValues: { ":scope": CATALOG_SCOPE, ":sort": catalogSort },
    }),
  );
}

async function backfillCatalogPage(
  doc: DynamoDBDocumentClient,
  tableName: string,
  page: CatalogScanPage,
): Promise<void> {
  for (const item of page.Items ?? []) await backfillCatalogItem(doc, tableName, item);
}

async function backfillCatalogIndex(doc: DynamoDBDocumentClient, tableName: string): Promise<void> {
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = (await doc.send(
      new ScanCommand({
        TableName: tableName,
        ProjectionExpression: "id, #name, catalogScope, catalogSort",
        ExpressionAttributeNames: { "#name": "name" },
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }),
    )) as CatalogScanPage;
    await backfillCatalogPage(doc, tableName, page);
    startKey = page.LastEvaluatedKey;
  } while (hasStartKey(startKey));
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
    table = await describeCatalogTable(client, tableName);
  } catch {
    return;
  }
  await ensureCatalogIndex(client, tableName, table);
  await backfillCatalogIndex(doc, tableName);
}
