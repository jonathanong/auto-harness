import {
  DescribeTableCommand,
  KeyType,
  ProjectionType,
  ResourceInUseException,
  ScalarAttributeType,
  UpdateTableCommand,
  type AttributeDefinition,
  type DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import { setTimeout as delay } from "node:timers/promises";

import {
  SESSIONS_PRIORITY_ORDER_INDEX,
  SESSIONS_REPOSITORY_PRIORITY_ORDER_INDEX,
} from "../control-plane-ordering.ts";

export { SESSIONS_PRIORITY_ORDER_INDEX, SESSIONS_REPOSITORY_PRIORITY_ORDER_INDEX };

const PRIORITY_INDEXES = [
  { name: SESSIONS_PRIORITY_ORDER_INDEX, rangeAttribute: "priorityOrder" },
  {
    name: SESSIONS_REPOSITORY_PRIORITY_ORDER_INDEX,
    rangeAttribute: "repositoryPriorityOrder",
  },
] as const;
const MAX_ACTIVE_POLLS = 300;
const ACTIVE_POLL_MS = 200;

function indexDefinitions(
  definitions: readonly AttributeDefinition[] | undefined,
  rangeAttribute: string,
): AttributeDefinition[] {
  const statusShard = definitions?.find((item) => item.AttributeName === "statusShard") ?? {
    AttributeName: "statusShard",
    AttributeType: ScalarAttributeType.S,
  };
  const range = definitions?.find((item) => item.AttributeName === rangeAttribute) ?? {
    AttributeName: rangeAttribute,
    AttributeType: ScalarAttributeType.S,
  };
  return [statusShard, range];
}

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

/**
 * Add the two durable session-list priority GSIs one at a time and wait until
 * each is queryable. DynamoDB permits only one GSI creation per UpdateTable.
 * Production CDK owns this schema; this repair path keeps pre-existing local
 * (and explicitly bootstrapped) tables compatible.
 */
export async function ensureSessionsPriorityIndexes(
  client: DynamoDBClient,
  tableName: string,
): Promise<void> {
  for (const index of PRIORITY_INDEXES) {
    for (let attempt = 0; attempt < MAX_ACTIVE_POLLS; attempt += 1) {
      let table;
      try {
        table = await client.send(new DescribeTableCommand({ TableName: tableName }));
      } catch {
        return;
      }
      const existing = table.Table?.GlobalSecondaryIndexes?.find(
        (item) => item.IndexName === index.name,
      );
      if (existing?.IndexStatus === "ACTIVE") break;
      if (!existing) {
        try {
          await client.send(
            new UpdateTableCommand({
              TableName: tableName,
              AttributeDefinitions: indexDefinitions(
                table.Table?.AttributeDefinitions,
                index.rangeAttribute,
              ),
              GlobalSecondaryIndexUpdates: [
                {
                  Create: {
                    IndexName: index.name,
                    KeySchema: [
                      { AttributeName: "statusShard", KeyType: KeyType.HASH },
                      { AttributeName: index.rangeAttribute, KeyType: KeyType.RANGE },
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
      await delay(ACTIVE_POLL_MS);
      if (attempt === MAX_ACTIVE_POLLS - 1) {
        throw new Error(`timed out waiting for ${index.name} to become ACTIVE`);
      }
    }
  }
}
