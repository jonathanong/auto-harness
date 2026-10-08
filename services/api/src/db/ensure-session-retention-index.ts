import {
  DescribeTableCommand,
  UpdateTableCommand,
  type DynamoDBClient,
} from "@aws-sdk/client-dynamodb";

export const SESSION_RETENTION_INDEX = "statusShard-completedAt";

/** Existing tables get the same sparse access path as fresh local and CDK tables. */
export async function ensureSessionRetentionIndex(
  client: DynamoDBClient,
  tableName: string,
): Promise<void> {
  const response = await client.send(new DescribeTableCommand({ TableName: tableName }));
  if (
    response.Table?.GlobalSecondaryIndexes?.some(
      (index) => index.IndexName === SESSION_RETENTION_INDEX,
    )
  )
    return;
  const definitions = response.Table?.AttributeDefinitions ?? [];
  const attributes = [...definitions];
  for (const name of ["statusShard", "completedAt"]) {
    if (!attributes.some((attribute) => attribute.AttributeName === name)) {
      attributes.push({ AttributeName: name, AttributeType: "S" });
    }
  }
  try {
    await client.send(
      new UpdateTableCommand({
        TableName: tableName,
        AttributeDefinitions: attributes,
        GlobalSecondaryIndexUpdates: [
          {
            Create: {
              IndexName: SESSION_RETENTION_INDEX,
              KeySchema: [
                { AttributeName: "statusShard", KeyType: "HASH" },
                { AttributeName: "completedAt", KeyType: "RANGE" },
              ],
              Projection: { ProjectionType: "KEYS_ONLY" },
            },
          },
        ],
      }),
    );
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !["ResourceInUseException", "LimitExceededException"].includes(error.name)
    )
      throw error;
  }
}
