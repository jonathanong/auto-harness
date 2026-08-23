import {
  DescribeTableCommand,
  KeyType,
  ProjectionType,
  ResourceInUseException,
  ScalarAttributeType,
  UpdateTableCommand,
  type DynamoDBClient,
} from "@aws-sdk/client-dynamodb";

const INDEX_NAME = "repositoryId-createdAt";
const DRAIN_INDEX_NAME = "cancelledByDrainOperationId-createdAt";

/** Add access paths to Sessions tables created before the durable drain indexes. */
export async function ensureSessionsRepositoryIndex(
  client: DynamoDBClient,
  tableName: string,
): Promise<void> {
  for (const [indexName, hashAttribute] of [
    [INDEX_NAME, "repositoryId"],
    [DRAIN_INDEX_NAME, "cancelledByDrainOperationId"],
  ] as const) {
    let table;
    try {
      table = await client.send(new DescribeTableCommand({ TableName: tableName }));
    } catch {
      return;
    }
    if (table.Table?.GlobalSecondaryIndexes?.some((index) => index.IndexName === indexName)) {
      continue;
    }
    const definitions = table.Table?.AttributeDefinitions ?? [];
    const withDefinitions = definitions.some((item) => item.AttributeName === hashAttribute)
      ? definitions
      : [...definitions, { AttributeName: hashAttribute, AttributeType: ScalarAttributeType.S }];
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
                  { AttributeName: hashAttribute, KeyType: KeyType.HASH },
                  { AttributeName: "createdAt", KeyType: KeyType.RANGE },
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
      ) {
        return;
      }
      throw error;
    }
  }
}
