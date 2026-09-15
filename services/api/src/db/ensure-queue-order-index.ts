import {
  DescribeTableCommand,
  KeyType,
  ProjectionType,
  ResourceInUseException,
  ScalarAttributeType,
  UpdateTableCommand,
  type DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import { SESSIONS_QUEUE_ORDER_INDEX } from "../control-plane-ordering.ts";

const QUEUE_ORDER_ATTRIBUTE = "queueOrder";

function isIgnorableIndexUpdate(error: unknown): boolean {
  return (
    error instanceof ResourceInUseException ||
    (typeof error === "object" &&
      error !== null &&
      "name" in error &&
      (error as { name?: unknown }).name === "LimitExceededException")
  );
}

/** Add the priority/FIFO queue GSI to Sessions tables created before this index existed. */
export async function ensureSessionsQueueOrderIndex(
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
      (index) => index.IndexName === SESSIONS_QUEUE_ORDER_INDEX,
    )
  ) {
    return;
  }
  const definitions = table.Table?.AttributeDefinitions ?? [];
  const withDefinitions = definitions.some((item) => item.AttributeName === QUEUE_ORDER_ATTRIBUTE)
    ? definitions
    : [
        ...definitions,
        { AttributeName: QUEUE_ORDER_ATTRIBUTE, AttributeType: ScalarAttributeType.S },
      ];
  try {
    await client.send(
      new UpdateTableCommand({
        TableName: tableName,
        AttributeDefinitions: withDefinitions,
        GlobalSecondaryIndexUpdates: [
          {
            Create: {
              IndexName: SESSIONS_QUEUE_ORDER_INDEX,
              KeySchema: [
                { AttributeName: "statusShard", KeyType: KeyType.HASH },
                { AttributeName: QUEUE_ORDER_ATTRIBUTE, KeyType: KeyType.RANGE },
              ],
              Projection: { ProjectionType: ProjectionType.ALL },
            },
          },
        ],
      }),
    );
  } catch (error) {
    if (isIgnorableIndexUpdate(error)) return;
    throw error;
  }
}
