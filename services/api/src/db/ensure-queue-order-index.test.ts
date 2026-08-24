/* eslint-disable max-lines -- index migration, backfill, and parity cases share one table fixture. */
import {
  CreateTableCommand,
  DeleteTableCommand,
  DescribeTableCommand,
  KeyType,
  ResourceInUseException,
  ScalarAttributeType,
  UpdateTableCommand,
  type DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  compareSessionsForQueue,
  queueOrderKey,
  SESSIONS_QUEUE_ORDER_INDEX,
} from "../control-plane-ordering.ts";
import { createDynamoClients } from "./dynamo.ts";
import { dynamoAvailable } from "./dynamo-test-helpers.ts";
import { ensureControlPlaneTables } from "./ensure-tables.ts";
import {
  backfillQueuedSessionQueueOrder,
  ensureSessionsQueueOrderIndex,
} from "./ensure-queue-order-index.ts";
import { statusShardAttr, tableNames } from "./dynamo.ts";
import { DynamoPlaneStorage } from "./plane-storage.ts";

const tableName = `AhQueueOrder${process.pid}`;
let client: DynamoDBClient | null = null;
let doc: ReturnType<typeof createDynamoClients>["doc"] | null = null;

beforeAll(async () => {
  if (!(await dynamoAvailable())) return;
  const clients = createDynamoClients();
  client = clients.client;
  doc = clients.doc;
  await client.send(
    new CreateTableCommand({
      TableName: tableName,
      BillingMode: "PAY_PER_REQUEST",
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

describe("ensureSessionsQueueOrderIndex", () => {
  it("leaves a table alone when it cannot be described", async () => {
    const unavailable = {
      send: async () => {
        throw new Error("offline");
      },
    } as never;
    await expect(ensureSessionsQueueOrderIndex(unavailable, "Sessions")).resolves.toBeUndefined();
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
                { AttributeName: "statusShard", AttributeType: ScalarAttributeType.S },
              ],
            },
          };
        }
        throw { name: "LimitExceededException" };
      },
    } as never;
    await expect(ensureSessionsQueueOrderIndex(mockedClient, "Sessions")).resolves.toBeUndefined();
    expect(commands).toEqual([expect.any(DescribeTableCommand), expect.any(UpdateTableCommand)]);
  });

  it("accepts an index migration already in progress", async () => {
    const mockedClient = {
      send: async (command: unknown) => {
        if (command instanceof DescribeTableCommand) return { Table: {} };
        throw new ResourceInUseException({ $metadata: {}, message: "busy" });
      },
    } as never;
    await expect(ensureSessionsQueueOrderIndex(mockedClient, "Sessions")).resolves.toBeUndefined();
  });

  it("propagates an unexpected index update failure", async () => {
    const mockedClient = {
      send: async (command: unknown) => {
        if (command instanceof DescribeTableCommand) return { Table: {} };
        throw new Error("unexpected update failure");
      },
    } as never;
    await expect(ensureSessionsQueueOrderIndex(mockedClient, "Sessions")).rejects.toThrow(
      "unexpected update failure",
    );
  });

  it("skips creating the index when it already exists", async () => {
    const mockedClient = {
      send: async (command: unknown) => {
        if (command instanceof DescribeTableCommand) {
          return {
            Table: { GlobalSecondaryIndexes: [{ IndexName: SESSIONS_QUEUE_ORDER_INDEX }] },
          };
        }
        throw new Error("should not update");
      },
    } as never;
    await expect(ensureSessionsQueueOrderIndex(mockedClient, "Sessions")).resolves.toBeUndefined();
  });

  it("backfills queued rows, ignores lost races, and matches compareSessionsForQueue", async () => {
    if (!client || !doc) {
      expect(true).toBe(true);
      return;
    }
    const tables = await ensureControlPlaneTables({
      client,
      prefix: `AhQueueOrderFill${process.pid}`,
    });
    const rows = [
      { id: "low", priority: 0, createdAt: "2026-01-01T00:00:00.000Z", queueShard: 0 },
      { id: "high", priority: 8, createdAt: "2026-01-01T00:00:01.000Z", queueShard: 0 },
    ];
    for (const row of rows) {
      await doc.send(
        new PutCommand({
          TableName: tables.sessions,
          Item: {
            ...row,
            status: "queued",
            statusShard: statusShardAttr("queued", row.queueShard),
          },
        }),
      );
    }
    await expect(backfillQueuedSessionQueueOrder(doc, tables.sessions, 1)).resolves.toBe(2);
    await expect(backfillQueuedSessionQueueOrder(doc, tables.sessions, 1)).resolves.toBe(0);
    const high = await doc.send(
      new GetCommand({ TableName: tables.sessions, Key: { id: "high" } }),
    );
    expect(high.Item?.queueOrder).toBe(queueOrderKey(rows[1]!));
    const queried = await doc.send(
      new QueryCommand({
        TableName: tables.sessions,
        IndexName: SESSIONS_QUEUE_ORDER_INDEX,
        KeyConditionExpression: "statusShard = :ss",
        ExpressionAttributeValues: { ":ss": statusShardAttr("queued", 0) },
      }),
    );
    const ids = (queried.Items ?? []).map((item) => item.id);
    const expected = [...rows].toSorted(compareSessionsForQueue).map((row) => row.id);
    expect(ids).toEqual(expected);
  });

  it("skips malformed queued items and treats a lost queueOrder write as success", async () => {
    const updates: unknown[] = [];
    const mockedDoc = {
      send: async (command: unknown) => {
        if (command instanceof QueryCommand) {
          return {
            Items: [{ id: "broken" }, { id: "ok", createdAt: "t", priority: 1, status: "queued" }],
          };
        }
        updates.push(command);
        throw { name: "ConditionalCheckFailedException" };
      },
    } as never;
    await expect(backfillQueuedSessionQueueOrder(mockedDoc, "Sessions", 1)).resolves.toBe(0);
    expect(updates).toEqual([expect.any(UpdateCommand)]);
  });

  it("reuses an existing queueOrder attribute definition", async () => {
    const commands: unknown[] = [];
    const mockedClient = {
      send: async (command: unknown) => {
        commands.push(command);
        if (command instanceof DescribeTableCommand) {
          return {
            Table: {
              AttributeDefinitions: [
                { AttributeName: "queueOrder", AttributeType: ScalarAttributeType.S },
              ],
            },
          };
        }
        throw { name: "LimitExceededException" };
      },
    } as never;
    await expect(ensureSessionsQueueOrderIndex(mockedClient, "Sessions")).resolves.toBeUndefined();
    expect((commands[1] as UpdateTableCommand).input.AttributeDefinitions).toEqual([
      { AttributeName: "queueOrder", AttributeType: "S" },
    ]);
  });

  it("pages through queued rows and reraises unexpected updates", async () => {
    let queries = 0;
    const paged = {
      send: async (command: unknown) => {
        if (command instanceof QueryCommand) {
          queries += 1;
          if (queries === 1) return { Items: [], LastEvaluatedKey: { id: "next" } };
          return { Items: [] };
        }
        return {};
      },
    } as never;
    await expect(backfillQueuedSessionQueueOrder(paged, "Sessions", 1)).resolves.toBe(0);
    expect(queries).toBe(2);
    const failing = {
      send: async (command: unknown) => {
        if (command instanceof QueryCommand) {
          return { Items: [{ id: "ok", createdAt: "t", priority: 1, status: "queued" }] };
        }
        throw new Error("write failed");
      },
    } as never;
    await expect(backfillQueuedSessionQueueOrder(failing, "Sessions", 1)).rejects.toThrow(
      "write failed",
    );
  });

  it("rescans queued rows on each backfill so requeued legacy sessions get queueOrder", async () => {
    let queries = 0;
    const storage = new DynamoPlaneStorage(
      {
        send: async (command: unknown) => {
          if (command instanceof QueryCommand) {
            queries += 1;
            return { Items: [] };
          }
          return {};
        },
      } as never,
      tableNames("AhQOnce"),
    );
    await storage.backfillQueuedSessionQueueOrder(1);
    await storage.backfillQueuedSessionQueueOrder(1);
    expect(queries).toBe(2);
  });
});
