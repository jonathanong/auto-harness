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

/** Add the repository access path to Sessions tables created before PR12. */
export async function ensureSessionsRepositoryIndex(
  client: DynamoDBClient,
  tableName: string,
): Promise<void> {
  let table;
  try {
    table = await client.send(new DescribeTableCommand({ TableName: tableName }));
  } catch {
    return;
  }
  if (table.Table?.GlobalSecondaryIndexes?.some((index) => index.IndexName === INDEX_NAME)) return;
  const definitions = table.Table?.AttributeDefinitions ?? [];
  const repositoryDefinition = definitions.some((item) => item.AttributeName === "repositoryId")
    ? definitions
    : [...definitions, { AttributeName: "repositoryId", AttributeType: ScalarAttributeType.S }];
  try {
    await client.send(
      new UpdateTableCommand({
        TableName: tableName,
        AttributeDefinitions: repositoryDefinition,
        GlobalSecondaryIndexUpdates: [
          {
            Create: {
              IndexName: INDEX_NAME,
              KeySchema: [
                { AttributeName: "repositoryId", KeyType: KeyType.HASH },
                { AttributeName: "createdAt", KeyType: KeyType.RANGE },
              ],
              Projection: { ProjectionType: ProjectionType.ALL },
            },
          },
        ],
      }),
    );
  } catch (error) {
    if (error instanceof ResourceInUseException) return;
    throw error;
  }
}
