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
  SESSIONS_LIST_CREATED_ORDER_INDEX,
  SESSIONS_REPOSITORY_CREATED_ORDER_INDEX,
  SESSIONS_ROUTE_WORKTREE_CREATED_ORDER_INDEX,
} from "../control-plane-ordering.ts";

/** The unsharded list indexes, in the order they are created (one GSI per table update). */
export const SESSION_LIST_INDEXES = [
  { name: SESSIONS_REPOSITORY_CREATED_ORDER_INDEX, hashAttribute: "repositoryId" },
  { name: SESSIONS_ROUTE_WORKTREE_CREATED_ORDER_INDEX, hashAttribute: "routeWorktreeId" },
  { name: SESSIONS_LIST_CREATED_ORDER_INDEX, hashAttribute: "sessionList" },
] as const;

const MAX_ACTIVE_POLLS = 300;
const ACTIVE_POLL_MS = 200;

function withStringAttributes(
  definitions: readonly AttributeDefinition[] | undefined,
  names: readonly string[],
): AttributeDefinition[] {
  const known = new Set((definitions ?? []).map((item) => item.AttributeName));
  return [
    ...(definitions ?? []),
    ...names
      .filter((name) => !known.has(name))
      .map((name) => ({ AttributeName: name, AttributeType: ScalarAttributeType.S })),
  ];
}

function isConcurrentIndexUpdate(error: unknown): boolean {
  const name =
    typeof error === "object" && error !== null ? (error as { name?: unknown }).name : "";
  return (
    error instanceof ResourceInUseException ||
    name === "ResourceInUseException" ||
    name === "LimitExceededException"
  );
}

/** True when every unsharded list index is ACTIVE; false when any is missing or building. */
export async function sessionListIndexesActive(
  client: DynamoDBClient,
  tableName: string,
): Promise<boolean> {
  const table = await client.send(new DescribeTableCommand({ TableName: tableName }));
  return SESSION_LIST_INDEXES.every(
    (index) =>
      table.Table?.GlobalSecondaryIndexes?.find((item) => item.IndexName === index.name)
        ?.IndexStatus === "ACTIVE",
  );
}

/**
 * Add the unsharded list GSIs one at a time and wait until each is queryable (DynamoDB
 * permits one GSI creation per UpdateTable). Production CDK owns this schema; this repair
 * path keeps pre-existing local (and explicitly bootstrapped) tables compatible.
 */
export async function ensureSessionListIndexes(
  client: DynamoDBClient,
  tableName: string,
): Promise<void> {
  for (const index of SESSION_LIST_INDEXES) {
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
              AttributeDefinitions: withStringAttributes(table.Table?.AttributeDefinitions, [
                index.hashAttribute,
                "createdOrder",
              ]),
              GlobalSecondaryIndexUpdates: [
                {
                  Create: {
                    IndexName: index.name,
                    KeySchema: [
                      { AttributeName: index.hashAttribute, KeyType: KeyType.HASH },
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
      if (attempt === MAX_ACTIVE_POLLS - 1) {
        throw new Error(`timed out waiting for ${index.name} to become ACTIVE`);
      }
      await delay(ACTIVE_POLL_MS);
    }
  }
}
