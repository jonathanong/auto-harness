import {
  DescribeTableCommand,
  KeyType,
  ProjectionType,
  ResourceInUseException,
  ScalarAttributeType,
  UpdateTableCommand,
  type DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  QueryCommand,
  UpdateCommand,
  type QueryCommandOutput,
} from "@aws-sdk/lib-dynamodb";

import { DEFAULT_QUEUE_SHARD_COUNT } from "@auto-harness/shared";
import {
  SESSIONS_QUEUE_ORDER_INDEX,
  SESSIONS_STATUS_CREATED_INDEX,
  queueOrderKey,
} from "../control-plane-ordering.ts";
import { statusShardAttr } from "./dynamo.ts";
import { isConditionalFailed, nextPageKey } from "./plane-storage-types.ts";

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

/** Write `queueOrder` onto active queued rows so the new GSI is populated before readers switch. */
export async function backfillQueuedSessionQueueOrder(
  doc: DynamoDBDocumentClient,
  tableName: string,
  shardCount: number = DEFAULT_QUEUE_SHARD_COUNT,
): Promise<number> {
  let updated = 0;
  for (let shard = 0; shard < shardCount; shard++) {
    let startKey: Record<string, unknown> | undefined;
    do {
      const page: QueryCommandOutput = await doc.send(
        new QueryCommand({
          TableName: tableName,
          IndexName: SESSIONS_STATUS_CREATED_INDEX,
          KeyConditionExpression: "statusShard = :ss",
          ExpressionAttributeValues: { ":ss": statusShardAttr("queued", shard) },
          ...(startKey ? { ExclusiveStartKey: startKey } : {}),
        }),
      );
      for (const item of page.Items ?? []) {
        if (
          typeof item.id !== "string" ||
          typeof item.createdAt !== "string" ||
          typeof item.priority !== "number" ||
          typeof item.queueOrder === "string"
        ) {
          continue;
        }
        try {
          await doc.send(
            new UpdateCommand({
              TableName: tableName,
              Key: { id: item.id },
              UpdateExpression: "SET queueOrder = :queueOrder",
              ConditionExpression: "#s = :queued AND attribute_not_exists(queueOrder)",
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: {
                ":queued": "queued",
                ":queueOrder": queueOrderKey({
                  id: item.id,
                  createdAt: item.createdAt,
                  priority: item.priority,
                }),
              },
            }),
          );
          updated += 1;
        } catch (error) {
          if (!isConditionalFailed(error)) throw error;
        }
      }
      startKey = nextPageKey(page.LastEvaluatedKey as Record<string, unknown> | undefined);
    } while (startKey !== undefined);
  }
  return updated;
}
