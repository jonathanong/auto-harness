import { DeleteTableCommand, type DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDynamoClients, type DynamoTableNames } from "./dynamo.ts";
import { ensureControlPlaneTables } from "./ensure-tables.ts";
import { DynamoPlaneStorageBase } from "./plane-storage-base.ts";

let client: DynamoDBClient;
let storage: DynamoPlaneStorageBase;
let tables: DynamoTableNames;

beforeAll(async () => {
  const clients = createDynamoClients();
  client = clients.client;
  tables = await ensureControlPlaneTables({ client, prefix: `Ah69Base${process.pid}` });
  storage = new DynamoPlaneStorageBase(clients.doc, tables);
});

afterAll(async () => {
  await Promise.all(
    Object.values(tables).map((TableName) => client.send(new DeleteTableCommand({ TableName }))),
  );
});

describe("DynamoPlaneStorageBase", () => {
  it("delegates durable adapter calls through one real DynamoDB context", async () => {
    const fence = { hostId: "base-host", connectionId: "base-connection" };
    const log = {
      sessionId: "base-session",
      timestampSeq: "2026-01-01T00:00:00.000Z#0000000001",
      stream: "stdout" as const,
      content: "base",
      timestamp: "2026-01-01T00:00:00.000Z",
      seq: 1,
    };
    expect(await storage.tryAcquireHostLock({ ...fence, replaceExisting: false })).toBe(true);
    expect(await storage.putLogFenced(log, fence)).toBe(true);
    await storage.putLog({ ...log, timestampSeq: "2026-01-01T00:00:00.000Z#0000000002", seq: 2 });
    expect((await storage.listLogs(log.sessionId)).map(({ seq }) => seq)).toEqual([1, 2]);
    expect(await storage.queryLogs(log.sessionId, { limit: 10 })).toHaveLength(2);
    await storage.deleteLog(log.sessionId, log.timestampSeq);
    expect(await storage.listSessionsByRepository("missing-repository")).toEqual([]);

    const markerAt = "2026-01-01T00:00:00.000Z";
    expect(await storage.acquireDeletionMarker("base-marker", "owner", markerAt)).toBe(true);
    expect(await storage.renewDeletionMarker("base-marker", "owner", markerAt)).toBe(true);
    await storage.releaseDeletionMarker("base-marker", "owner");

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
    expect((await storage.listAuthAccounts()).map(({ id }) => id)).toContain(account.id);
    await storage.deleteAuthAccount(account.id);
    expect(await storage.getAuthAccount(account.id)).toBeNull();

    expect(
      await storage.failExpiredResumeSession({
        sessionId: "missing",
        queueShard: 0,
        pinExpiresAt: "t",
      }),
    ).toBe(false);
    expect(
      await storage.markReconnectPending({
        sessionId: "missing",
        hostId: "host",
        worktreeId: "worktree",
        deadlineAt: "t",
        connectionId: "connection",
      }),
    ).toBe(false);
    expect(
      await storage.requeueUsageLimitedSession({
        sessionId: "missing",
        worktreeId: "worktree",
        attemptId: "attempt",
        providerAccountId: "account",
        queueShard: 0,
        now: "t",
        usageLimitedUntil: "later",
      }),
    ).toBe(false);
    expect(
      await storage.restoreMainCheckoutReconnect({
        sessionId: "missing",
        hostId: "host",
        repositoryId: "repository",
        connectionId: "connection",
        previousConnectionId: "previous",
      }),
    ).toBe(false);
    expect(
      await storage.skipScheduleForActiveConcurrency({
        scheduleId: "missing",
        expectedNextRunAt: "t",
        newNextRunAt: "later",
        concurrencyId: "concurrency",
        sessionId: "session",
      }),
    ).toBe(false);
  });
});
