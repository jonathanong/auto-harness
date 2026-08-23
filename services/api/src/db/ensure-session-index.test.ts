import {
  BillingMode,
  CreateTableCommand,
  DeleteTableCommand,
  DescribeTableCommand,
  KeyType,
  ResourceInUseException,
  UpdateTableCommand,
  ScalarAttributeType,
  type DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createDynamoClients } from "./dynamo.ts";
import { dynamoAvailable } from "./dynamo-test-helpers.ts";
import {
  ensureSchedulesRepositoryIndex,
  ensureSessionsRepositoryIndex,
} from "./ensure-session-index.ts";

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
  it("adds the repository/id index to an existing Schedules table", async () => {
    const commands: unknown[] = [];
    const mockedClient = {
      send: async (command: unknown) => {
        commands.push(command);
        return command instanceof DescribeTableCommand
          ? { Table: { AttributeDefinitions: [] } }
          : {};
      },
    } as never;

    await ensureSchedulesRepositoryIndex(mockedClient, "Schedules");

    expect((commands[1] as UpdateTableCommand).input).toMatchObject({
      TableName: "Schedules",
      AttributeDefinitions: [{ AttributeName: "repositoryId", AttributeType: "S" }],
      GlobalSecondaryIndexUpdates: [
        {
          Create: {
            IndexName: "repositoryId-id",
            KeySchema: [
              { AttributeName: "repositoryId", KeyType: "HASH" },
              { AttributeName: "id", KeyType: "RANGE" },
            ],
          },
        },
      ],
    });
  });

  it("does not update an existing Schedules repository index", async () => {
    const send = vi.fn().mockResolvedValue({
      Table: { GlobalSecondaryIndexes: [{ IndexName: "repositoryId-id" }] },
    });

    await ensureSchedulesRepositoryIndex({ send } as never, "Schedules");

    expect(send).toHaveBeenCalledOnce();
  });

  it("leaves a table alone when it cannot be described", async () => {
    const unavailable = {
      send: async () => {
        throw new Error("offline");
      },
    } as never;

    await expect(ensureSessionsRepositoryIndex(unavailable, "Sessions")).resolves.toBeUndefined();
  });

  it("accepts a concurrent index migration without replacing existing definitions", async () => {
    const commands: unknown[] = [];
    const mockedClient = {
      send: async (command: unknown) => {
        commands.push(command);
        if (command instanceof DescribeTableCommand) {
          return {
            Table: {
              AttributeDefinitions: [
                { AttributeName: "repositoryId", AttributeType: ScalarAttributeType.S },
              ],
            },
          };
        }
        throw { name: "LimitExceededException" };
      },
    } as never;

    await expect(ensureSessionsRepositoryIndex(mockedClient, "Sessions")).resolves.toBeUndefined();
    expect(commands).toEqual([expect.any(DescribeTableCommand), expect.any(UpdateTableCommand)]);
    expect((commands[1] as UpdateTableCommand).input).toMatchObject({
      AttributeDefinitions: [{ AttributeName: "repositoryId", AttributeType: "S" }],
    });
  });

  it("accepts an index migration already in progress", async () => {
    const mockedClient = {
      send: async (command: unknown) => {
        if (command instanceof DescribeTableCommand) return { Table: {} };
        throw new ResourceInUseException({ $metadata: {}, message: "busy" });
      },
    } as never;

    await expect(ensureSessionsRepositoryIndex(mockedClient, "Sessions")).resolves.toBeUndefined();
  });

  it("propagates an unexpected index update failure", async () => {
    const mockedClient = {
      send: async (command: unknown) => {
        if (command instanceof DescribeTableCommand) return { Table: {} };
        throw new Error("unexpected update failure");
      },
    } as never;

    await expect(ensureSessionsRepositoryIndex(mockedClient, "Sessions")).rejects.toThrow(
      "unexpected update failure",
    );
  });

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
