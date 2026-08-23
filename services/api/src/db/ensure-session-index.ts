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
const SCHEDULES_INDEX_NAME = "repositoryId-id";
const INDEX_ACTIVE_POLL_MS = 200;
const INDEX_ACTIVE_MAX_POLLS = 300;

/** Add access paths to Sessions tables created before the durable drain indexes. */
export async function ensureSessionsRepositoryIndex(
  client: DynamoDBClient,
  tableName: string,
): Promise<void> {
  await ensureRepositoryIndex(client, tableName, SESSIONS_INDEX_NAME, "createdAt", false);
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
  waitForActive: boolean,
): Promise<void> {
  for (let poll = 0; poll < INDEX_ACTIVE_MAX_POLLS; poll += 1) {
    let table;
    try {
      table = await client.send(new DescribeTableCommand({ TableName: tableName }));
    } catch {
      return;
    }
    const existing = table.Table?.GlobalSecondaryIndexes?.find(
      (index) => index.IndexName === indexName,
    );
    if (existing) {
      if (!waitForActive || existing.IndexStatus === undefined || existing.IndexStatus === "ACTIVE")
        return;
      await new Promise((resolve) => setTimeout(resolve, INDEX_ACTIVE_POLL_MS));
      continue;
    }
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
      if (!waitForActive) return;
    } catch (error) {
      if (
        error instanceof ResourceInUseException ||
        (typeof error === "object" &&
          error !== null &&
          "name" in error &&
          (error as { name?: unknown }).name === "LimitExceededException")
      ) {
        if (!waitForActive) return;
        await new Promise((resolve) => setTimeout(resolve, INDEX_ACTIVE_POLL_MS));
        continue;
      }
      throw error;
    }
  }
  throw new Error(`timed out waiting for DynamoDB index ${indexName} on ${tableName}`);
}
