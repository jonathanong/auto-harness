import { DeleteTableCommand, type DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDynamoClients, type DynamoTableNames } from "./dynamo.ts";
import { ensureControlPlaneTables } from "./ensure-tables.ts";
import { DynamoPlaneStorageBase } from "./plane-storage-base.ts";

let storage: DynamoPlaneStorageBase;
let client: DynamoDBClient;
let tables: DynamoTableNames;

beforeAll(async () => {
  const clients = createDynamoClients();
  client = clients.client;
  tables = await ensureControlPlaneTables({ client, prefix: `AhBase${process.pid}` });
  storage = new DynamoPlaneStorageBase(clients.doc, tables);
});

afterAll(async () => {
  await Promise.all(
    Object.values(tables).map((TableName) => client.send(new DeleteTableCommand({ TableName }))),
  );
});

describe("DynamoPlaneStorageBase real-Dynamo delegators", () => {
  it("routes fenced logs and uncommon lifecycle writes to their durable adapters", async () => {
    const fence = { hostId: "base-host", connectionId: "base-connection" };
    expect(await storage.tryAcquireHostLock({ ...fence, replaceExisting: false })).toBe(true);
    const log = {
      sessionId: "base-session",
      timestampSeq: "2026-01-01T00:00:00.000Z#0000000001",
      stream: "stdout",
      content: "base",
      timestamp: "2026-01-01T00:00:00.000Z",
      seq: 1,
    };
    expect(await storage.putLogFenced(log, fence)).toBe(true);
    await storage.deleteLog(log.sessionId, log.timestampSeq);
    expect(
      await storage.restoreMainCheckoutReconnect({
        sessionId: "missing",
        hostId: "missing-host",
        repositoryId: "repository",
        connectionId: "connection",
        previousConnectionId: "previous",
      }),
    ).toBe(false);
    expect(
      await storage.failExpiredResumeSession({
        sessionId: "missing",
        queueShard: 0,
        pinExpiresAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toBe(false);
    expect(
      await storage.markReconnectPending({
        sessionId: "missing",
        hostId: "missing-host",
        worktreeId: "missing-worktree",
        deadlineAt: "2026-01-01T00:00:00.000Z",
        connectionId: "connection",
      }),
    ).toBe(false);
    expect(
      await storage.requeueUsageLimitedSession({
        sessionId: "missing",
        worktreeId: "missing-worktree",
        attemptId: "attempt",
        providerAccountId: "missing-account",
        queueShard: 0,
        now: "2026-01-01T00:00:00.000Z",
        usageLimitedUntil: "2026-01-02T00:00:00.000Z",
      }),
    ).toBe(false);
  });

  it("routes authenticated account CRUD and username lookup through DynamoDB", async () => {
    const account = {
      id: "base-user",
      username: "base-user",
      kind: "user" as const,
      role: "operator" as const,
      passwordHash: "hash",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    await storage.putAuthAccount(account);
    expect((await storage.getAuthAccount(account.id))?.username).toBe(account.username);
    expect((await storage.getAuthAccountByUsername(account.username))?.id).toBe(account.id);
    expect((await storage.listAuthAccounts()).map((item) => item.id)).toContain(account.id);
    await storage.deleteAuthAccount(account.id);
    expect(await storage.getAuthAccount(account.id)).toBeNull();
  });
});
