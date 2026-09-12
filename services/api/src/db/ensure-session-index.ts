import {
  DescribeTableCommand,
  KeyType,
  ProjectionType,
  ResourceInUseException,
  ScalarAttributeType,
  UpdateTableCommand,
  type DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import { setTimeout as delay } from "node:timers/promises";

const SESSIONS_INDEX_NAME = "repositoryId-createdAt";
const SESSIONS_PARENT_INDEX_NAME = "parentSessionId-createdOrder";
const SCHEDULES_INDEX_NAME = "repositoryId-id";
const MAX_PARENT_INDEX_ACTIVE_POLLS = 300;
const PARENT_INDEX_ACTIVE_POLL_MS = 200;

function isConcurrentIndexUpdate(error: unknown): boolean {
  return (
    error instanceof ResourceInUseException ||
    (typeof error === "object" &&
      error !== null &&
      "name" in error &&
      ((error as { name?: unknown }).name === "ResourceInUseException" ||
        (error as { name?: unknown }).name === "LimitExceededException"))
  );
}

/** Add access paths to Sessions tables created before the durable drain indexes. */
export async function ensureSessionsRepositoryIndex(
  client: DynamoDBClient,
  tableName: string,
): Promise<void> {
  await ensureRepositoryIndex(client, tableName, SESSIONS_INDEX_NAME, "createdAt", false);
}

/** Add the direct-child history access path to existing Sessions tables. */
export async function ensureSessionsParentIndex(
  client: DynamoDBClient,
  tableName: string,
): Promise<void> {
  for (let attempt = 0; attempt < MAX_PARENT_INDEX_ACTIVE_POLLS; attempt += 1) {
    let table;
    try {
      table = await client.send(new DescribeTableCommand({ TableName: tableName }));
    } catch (error) {
      if (attempt === 0) return;
      throw error;
    }
    const parentIndex = table.Table?.GlobalSecondaryIndexes?.find(
      (index) => index.IndexName === SESSIONS_PARENT_INDEX_NAME,
    );
    if (table.Table?.TableStatus === "ACTIVE" && parentIndex?.IndexStatus === "ACTIVE") return;
    if (!parentIndex) {
      const definitions = table.Table?.AttributeDefinitions ?? [];
      const withParent = definitions.some((item) => item.AttributeName === "parentSessionId")
        ? definitions
        : [
            ...definitions,
            { AttributeName: "parentSessionId", AttributeType: ScalarAttributeType.S },
          ];
      try {
        await client.send(
          new UpdateTableCommand({
            TableName: tableName,
            AttributeDefinitions: withParent,
            GlobalSecondaryIndexUpdates: [
              {
                Create: {
                  IndexName: SESSIONS_PARENT_INDEX_NAME,
                  KeySchema: [
                    { AttributeName: "parentSessionId", KeyType: KeyType.HASH },
                    { AttributeName: "createdOrder", KeyType: KeyType.RANGE },
                  ],
                  Projection: { ProjectionType: ProjectionType.ALL },
                },
              },
            ],
          }),
        );
      } catch (error) {
        if (!isConcurrentIndexUpdate(error)) throw error;
      }
    }
    await delay(PARENT_INDEX_ACTIVE_POLL_MS);
    if (attempt === MAX_PARENT_INDEX_ACTIVE_POLLS - 1) {
      throw new Error(`timed out waiting for ${SESSIONS_PARENT_INDEX_NAME} to become ACTIVE`);
    }
  }
}

/** Add the repository count access path to Schedules tables created before pagination. */
export async function ensureSchedulesRepositoryIndex(
  client: DynamoDBClient,
  tableName: string,
): Promise<void> {
  await ensureRepositoryIndex(client, tableName, SCHEDULES_INDEX_NAME, "id", true);
}

async function ensureRepositoryIndex(
  client: DynamoDBClient,
  tableName: string,
  indexName: string,
  rangeAttribute: string,
  strict: boolean,
): Promise<void> {
  let table;
  try {
    table = await client.send(new DescribeTableCommand({ TableName: tableName }));
  } catch (error) {
    if (strict) throw error;
    return;
  }
  if (table.Table?.GlobalSecondaryIndexes?.some((index) => index.IndexName === indexName)) return;
  const definitions = table.Table?.AttributeDefinitions ?? [];
  const withDefinitions = definitions.some((item) => item.AttributeName === "repositoryId")
    ? definitions
    : [...definitions, { AttributeName: "repositoryId", AttributeType: ScalarAttributeType.S }];
  try {
    await client.send(
      new UpdateTableCommand({
        TableName: tableName,
        AttributeDefinitions: withDefinitions,
        GlobalSecondaryIndexUpdates: [
          {
            Create: {
              IndexName: indexName,
              KeySchema: [
                { AttributeName: "repositoryId", KeyType: KeyType.HASH },
                { AttributeName: rangeAttribute, KeyType: KeyType.RANGE },
              ],
              Projection: { ProjectionType: ProjectionType.ALL },
            },
          },
        ],
      }),
    );
  } catch (error) {
    if (
      !strict &&
      (error instanceof ResourceInUseException ||
        (typeof error === "object" &&
          error !== null &&
          "name" in error &&
          (error as { name?: unknown }).name === "LimitExceededException"))
    ) {
      return;
    }
    throw error;
  }
}
