import { DeleteTableCommand, type DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDynamoClients, type DynamoTableNames } from "./dynamo.ts";
import { ensureControlPlaneTables } from "./ensure-tables.ts";
import { DynamoPlaneStorageBase } from "./plane-storage-base.ts";

let client: DynamoDBClient;
let storage: DynamoPlaneStorageBase;
let tables: DynamoTableNames;
let doc: ReturnType<typeof createDynamoClients>["doc"];

const record = {
  sessionId: "usage-session",
  repositoryId: "repo",
  attemptId: "attempt-1",
  worktreeId: "worktree-1",
  kind: "delta" as const,
  sequence: 1,
  inputTokens: "2",
  observedAt: "2026-01-01T00:00:00.000Z",
  receivedAt: "2026-01-01T00:00:01.000Z",
  source: "cli" as const,
};

beforeAll(async () => {
  const clients = createDynamoClients();
  client = clients.client;
  doc = clients.doc;
  tables = await ensureControlPlaneTables({ client, prefix: `AhCost${process.pid}` });
  storage = new DynamoPlaneStorageBase(doc, tables);
  await doc.send(
    new PutCommand({
      TableName: tables.hostLocks,
      Item: { hostId: "host-1", connectionId: "connection-1" },
    }),
  );
  await doc.send(
    new PutCommand({
      TableName: tables.sessions,
      Item: {
        id: record.sessionId,
        attemptId: record.attemptId,
        worktreeId: record.worktreeId,
      },
    }),
  );
});

afterAll(async () => {
  await Promise.all(
    Object.values(tables).map((TableName) => client.send(new DeleteTableCommand({ TableName }))),
  );
});

describe("Dynamo usage storage", () => {
  it("fences, deduplicates, rejects mixed kinds, and lists records", async () => {
    expect(await storage.putUsageRecord(record)).toBe(false);
    const fence = { hostId: "host-1", connectionId: "connection-1" };
    expect(await storage.putUsageRecord(record, fence)).toBe(true);
    expect(await storage.putUsageRecord(record, fence)).toBe(false);
    expect(
      await storage.putUsageRecord(
        { ...record, kind: "cumulative", sequence: 2, inputTokens: "4" },
        fence,
      ),
    ).toBe(false);
    expect(await storage.listUsageRecords(record.sessionId)).toEqual([
      expect.objectContaining({ sessionId: record.sessionId, inputTokens: "2" }),
    ]);
    const query = doc.send;
    doc.send = (async (command: unknown) => {
      if (command instanceof QueryCommand) expect(command.input.ConsistentRead).toBe(true);
      return query.call(doc, command as never);
    }) as never;
    await storage.listUsageRecords(record.sessionId);
    expect(await storage.listUsageRecords()).toEqual([
      expect.objectContaining({ sessionId: record.sessionId }),
    ]);
  });
});
