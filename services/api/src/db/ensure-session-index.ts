import {
  DescribeTableCommand,
  KeyType,
  ProjectionType,
  ResourceInUseException,
  ScalarAttributeType,
  UpdateTableCommand,
  type DynamoDBClient,
} from "@aws-sdk/client-dynamodb";

const SESSIONS_INDEX_NAME = "repositoryId-createdAt";
const SESSIONS_PARENT_INDEX_NAME = "parentSessionId-createdOrder";
const SCHEDULES_INDEX_NAME = "repositoryId-id";

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
  let table;
  try {
    table = await client.send(new DescribeTableCommand({ TableName: tableName }));
  } catch {
    return;
  }
  if (
    table.Table?.GlobalSecondaryIndexes?.some(
      (index) => index.IndexName === SESSIONS_PARENT_INDEX_NAME,
    )
  )
    return;
  const definitions = table.Table?.AttributeDefinitions ?? [];
  const withParent = definitions.some((item) => item.AttributeName === "parentSessionId")
    ? definitions
    : [...definitions, { AttributeName: "parentSessionId", AttributeType: ScalarAttributeType.S }];
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
    if (
      error instanceof ResourceInUseException ||
      (typeof error === "object" &&
        error !== null &&
        "name" in error &&
        (error as { name?: unknown }).name === "LimitExceededException")
    )
      return;
    throw error;
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
