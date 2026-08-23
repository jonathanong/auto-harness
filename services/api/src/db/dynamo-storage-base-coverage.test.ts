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
    const batch = Array.from({ length: 25 }, (_, index) => {
      const seq = index + 3;
      return {
        ...log,
        timestampSeq: `2026-01-01T00:00:00.000Z#${String(seq).padStart(10, "0")}`,
        seq,
      };
    });
    expect(await storage.putLogsFenced([], fence)).toBe(true);
    expect(
      await storage.putLogsFenced(
        [...batch, { ...batch.at(-1)!, content: "replayed duplicate" }],
        fence,
      ),
    ).toBe(true);
    expect(
      await storage.putLogsFenced(
        [{ ...log, timestampSeq: "2026-01-01T00:00:00.000Z#0000000028", seq: 28 }],
        { ...fence, connectionId: "stale" },
      ),
    ).toBe(false);
    expect((await storage.listLogs(log.sessionId)).map(({ seq }) => seq)).toEqual(
      Array.from({ length: 27 }, (_, index) => index + 1),
    );
    expect((await storage.listLogs(log.sessionId)).at(-1)?.content).toBe("replayed duplicate");
    expect(await storage.queryLogs(log.sessionId, { limit: 10 })).toHaveLength(10);
    await storage.deleteLog(log.sessionId, log.timestampSeq);
    expect(await storage.listSessionsByRepository("missing-repository")).toEqual([]);
    expect(await storage.countSessionsByRepository("missing-repository", "base-host")).toBe(0);

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
    expect(await storage.acquireDeletionMarker(`principal:${account.id}`, "owner", markerAt)).toBe(
      true,
    );
    expect(
      await storage.deleteAuthAccountFenced(account.id, {
        key: `principal:${account.id}`,
        owner: "owner",
        now: markerAt,
      }),
    ).toBe("deleted");
    await storage.releaseDeletionMarker(`principal:${account.id}`, "owner");
    expect(await storage.getAuthAccount(account.id)).toBeNull();
    await storage.putAuthAccount({ ...account, id: "base-user-unfenced", username: "unfenced" });
    await storage.deleteAuthAccount("base-user-unfenced");

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
      await storage.skipScheduleForClosedRepository({
        scheduleId: "missing",
        repositoryId: "repository",
        expectedNextRunAt: "t",
        newNextRunAt: "later",
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
    const audit = {
      id: "base-audit",
      createdAt: markerAt,
      actor: { id: "system", kind: "system" as const, role: "system" as const },
      action: "schedule:skip",
      resourceType: "schedule",
      resourceId: "missing",
      outcome: "failed" as const,
      metadata: {},
    };
    expect(
      await storage.skipOwnerlessScheduleAndAudit({
        scheduleId: "missing-ownerless",
        expectedNextRunAt: "t",
        newNextRunAt: "later",
        lastRunAt: "t",
        audit,
      }),
    ).toBe(false);
    expect(
      await storage.skipScheduleForPrincipalDrainAndAudit({
        scheduleId: "missing-principal",
        repositoryId: "repository",
        principalId: "principal",
        operationId: "operation",
        expectedNextRunAt: "t",
        newNextRunAt: "later",
        audit: { ...audit, id: "base-principal-audit" },
      }),
    ).toBe(false);
  });
});
