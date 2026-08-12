import {
  BillingMode,
  CreateTableCommand,
  DeleteTableCommand,
  DescribeTableCommand,
  KeyType,
  ScalarAttributeType,
  type DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDynamoClients } from "./dynamo.ts";
import { dynamoAvailable } from "./dynamo-test-helpers.ts";
import { ensureSessionsRepositoryIndex } from "./ensure-session-index.ts";

const tableName = `AhIndex${process.pid}`;
let client: DynamoDBClient | null = null;

beforeAll(async () => {
  if (!(await dynamoAvailable())) return;
  client = createDynamoClients().client;
  await client.send(
    new CreateTableCommand({
      TableName: tableName,
      BillingMode: BillingMode.PAY_PER_REQUEST,
      AttributeDefinitions: [
        { AttributeName: "id", AttributeType: ScalarAttributeType.S },
        { AttributeName: "statusShard", AttributeType: ScalarAttributeType.S },
        { AttributeName: "createdAt", AttributeType: ScalarAttributeType.S },
      ],
      KeySchema: [{ AttributeName: "id", KeyType: KeyType.HASH }],
      GlobalSecondaryIndexes: [
        {
          IndexName: "statusShard-createdAt",
          KeySchema: [
            { AttributeName: "statusShard", KeyType: KeyType.HASH },
            { AttributeName: "createdAt", KeyType: KeyType.RANGE },
          ],
          Projection: { ProjectionType: "ALL" },
        },
      ],
    }),
  );
});

afterAll(async () => {
  if (client) await client.send(new DeleteTableCommand({ TableName: tableName }));
});

describe("ensureSessionsRepositoryIndex", () => {
  it("migrates an existing Sessions table once", async () => {
    if (!client) {
      expect(true).toBe(true);
      return;
    }
    await ensureSessionsRepositoryIndex(client, tableName);
    await ensureSessionsRepositoryIndex(client, tableName);
    const table = await client.send(new DescribeTableCommand({ TableName: tableName }));
    expect(table.Table?.AttributeDefinitions).toContainEqual({
      AttributeName: "repositoryId",
      AttributeType: "S",
    });
    expect(table.Table?.GlobalSecondaryIndexes).toContainEqual(
      expect.objectContaining({ IndexName: "repositoryId-createdAt" }),
    );
  });
});
