/* eslint-disable max-lines -- provider lease storage cases share transaction fixtures. */
import { DeleteTableCommand, type DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_MAX_CONCURRENT_SESSIONS } from "@auto-harness/shared";

import { createDynamoClients, type DynamoTableNames } from "./dynamo.ts";
import { ensureControlPlaneTables } from "./ensure-tables.ts";
import { releaseTimedOutHostAssignment } from "./plane-storage-host-assignment.ts";
import {
  backfillProviderAccountLease,
  forceReleaseProviderAccountLease,
  getProviderAccountLeaseLock,
  getProviderAccountLeaseHolderSessions,
  listProviderAccountLeaseLocks,
  providerAccountLeaseDeleteItems,
  releaseProviderAccountLease,
  releaseTimedOutProviderAccountLease,
} from "./plane-storage-provider-account-leases.ts";
import { DynamoPlaneStorageBase } from "./plane-storage-base.ts";
import { putSession } from "./plane-storage-sessions.ts";
import type { PlaneStorageCtx } from "./plane-storage-types.ts";

describe("provider account lease storage", () => {
  it("fences a force release by account, slot, session, and attempt in one transaction", async () => {
    const send = vi.fn().mockResolvedValue({});
    await expect(
      forceReleaseProviderAccountLease(
        {
          doc: { send },
          tables: { providerAccounts: "Accounts", sessions: "Sessions", concurrencyLocks: "Locks" },
        } as never,
        {
          providerAccountId: "acct",
          slot: 7,
          concurrencyId: "provider-lease:acct:7",
          sessionId: "sess",
          attemptId: "attempt",
        },
      ),
    ).resolves.toBe(true);
    const request = send.mock.calls[0]?.[0] as { input: { TransactItems: unknown[] } };
    expect(request.input.TransactItems).toMatchObject([
      { ConditionCheck: { TableName: "Accounts", ConditionExpression: "attribute_exists(id)" } },
      {
        Update: {
          TableName: "Sessions",
          UpdateExpression: "REMOVE providerAccountLease",
          ConditionExpression: expect.stringContaining("#s IN"),
        },
      },
      {
        Delete: {
          TableName: "Locks",
          ConditionExpression: expect.stringContaining("sessionId = :sessionId"),
          ExpressionAttributeValues: expect.objectContaining({
            ":providerAccountId": "acct",
            ":slot": 7,
            ":sessionId": "sess",
            ":attemptId": "attempt",
          }),
        },
      },
    ]);
  });

  it("reads one lock and delegates the lease storage facade methods", async () => {
    const lock = {
      concurrencyId: "provider-lease:acct:0",
      providerAccountId: "acct",
      slot: 0,
      sessionId: "sess",
      attemptId: "attempt",
    };
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Item: lock })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Item: lock })
      .mockResolvedValueOnce({ Responses: { Locks: [lock] } })
      .mockResolvedValueOnce({ Responses: { Sessions: [{ id: "sess", status: "cancelled" }] } })
      .mockResolvedValueOnce({});
    const tables = {
      providerAccounts: "Accounts",
      sessions: "Sessions",
      concurrencyLocks: "Locks",
    } as never;
    const ctx = { doc: { send }, tables } as never;

    await expect(getProviderAccountLeaseLock(ctx, lock.concurrencyId)).resolves.toEqual(lock);
    await expect(getProviderAccountLeaseLock(ctx, "missing")).resolves.toBeNull();

    const storage = new DynamoPlaneStorageBase({ send } as never, tables);
    await expect(storage.getProviderAccountLeaseLock(lock.concurrencyId)).resolves.toEqual(lock);
    const locks = await storage.listProviderAccountLeaseLocks("acct", 1);
    expect(locks).toEqual([lock]);
    await expect(storage.getProviderAccountLeaseHolderSessions(locks)).resolves.toEqual(
      new Map([["sess", { id: "sess", status: "cancelled" }]]),
    );
    await expect(
      storage.forceReleaseProviderAccountLease({
        providerAccountId: "acct",
        slot: 0,
        concurrencyId: lock.concurrencyId,
        sessionId: "sess",
        attemptId: "attempt",
      }),
    ).resolves.toBe(true);
  });

  it("fails closed when the force-release transaction loses any condition", async () => {
    const send = vi.fn().mockRejectedValue({
      name: "TransactionCanceledException",
      CancellationReasons: [{ Code: "ConditionalCheckFailed" }],
    });
    await expect(
      forceReleaseProviderAccountLease(
        {
          doc: { send },
          tables: { providerAccounts: "Accounts", sessions: "Sessions", concurrencyLocks: "Locks" },
        } as never,
        {
          providerAccountId: "acct",
          slot: 0,
          concurrencyId: "provider-lease:acct:0",
          sessionId: "sess",
          attemptId: "attempt",
        },
      ),
    ).resolves.toBe(false);
  });

  it("uses strong BatchGet reads and retries unprocessed lease and holder keys", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Responses: {
          Locks: [
            {
              concurrencyId: "provider-lease:acct:2",
              providerAccountId: "acct",
              slot: 2,
              sessionId: "sess",
              attemptId: "attempt",
            },
          ],
        },
        UnprocessedKeys: {
          Locks: { Keys: [{ concurrencyId: "provider-lease:acct:1" }], ConsistentRead: true },
        },
      })
      .mockResolvedValueOnce({ Responses: { Locks: [] }, UnprocessedKeys: {} })
      .mockResolvedValueOnce({
        Responses: { Sessions: [{ id: "sess", status: "cancelled" }] },
        UnprocessedKeys: {},
      });
    const ctx = {
      doc: { send },
      tables: { concurrencyLocks: "Locks", sessions: "Sessions" },
    } as never;
    const leases = await listProviderAccountLeaseLocks(ctx, "acct", 3);
    expect(leases).toHaveLength(1);
    const sessions = await getProviderAccountLeaseHolderSessions(ctx, [...leases, ...leases]);
    expect(sessions.get("sess")).toMatchObject({ status: "cancelled" });
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      input: { RequestItems: { Locks: { ConsistentRead: true } } },
    });
    expect(send.mock.calls[1]?.[0]).toMatchObject({
      input: { RequestItems: { Locks: { Keys: [{ concurrencyId: "provider-lease:acct:1" }] } } },
    });
    expect(send.mock.calls[2]?.[0]).toMatchObject({
      input: { RequestItems: { Sessions: { ConsistentRead: true, Keys: [{ id: "sess" }] } } },
    });
  });

  it("handles empty BatchGet responses and an empty holder set", async () => {
    const send = vi.fn().mockResolvedValue({});
    const ctx = {
      doc: { send },
      tables: { concurrencyLocks: "Locks", sessions: "Sessions" },
    } as never;
    await expect(listProviderAccountLeaseLocks(ctx, "acct", 1)).resolves.toEqual([]);
    await expect(getProviderAccountLeaseHolderSessions(ctx, [])).resolves.toEqual(new Map());
  });

  it("bounds retries when DynamoDB keeps returning unprocessed keys", async () => {
    const send = vi.fn().mockResolvedValue({
      UnprocessedKeys: {
        Locks: { Keys: [{ concurrencyId: "provider-lease:acct:0" }], ConsistentRead: true },
      },
    });
    await expect(
      listProviderAccountLeaseLocks(
        { doc: { send }, tables: { concurrencyLocks: "Locks" } } as never,
        "acct",
        1,
      ),
    ).rejects.toThrow("DynamoDB BatchGetItem left unprocessed keys");
    expect(send).toHaveBeenCalledTimes(8);
  });

  it("rethrows unexpected force-release transaction failures", async () => {
    const send = vi.fn().mockRejectedValue(new Error("transaction unavailable"));
    await expect(
      forceReleaseProviderAccountLease(
        {
          doc: { send },
          tables: { providerAccounts: "Accounts", sessions: "Sessions", concurrencyLocks: "Locks" },
        } as never,
        {
          providerAccountId: "acct",
          slot: 0,
          concurrencyId: "provider-lease:acct:0",
          sessionId: "sess",
          attemptId: "attempt",
        },
      ),
    ).rejects.toThrow("transaction unavailable");
  });

  it("deletes the attempt-owned lock and ignores a lost condition", async () => {
    const send = vi.fn().mockResolvedValue({});
    await releaseProviderAccountLease(
      { doc: { send }, tables: { concurrencyLocks: "Locks" } } as never,
      { concurrencyId: "provider-lease:acct:0", sessionId: "sess", attemptId: "attempt" },
    );
    expect(send).toHaveBeenCalledOnce();
    send.mockRejectedValueOnce({ name: "ConditionalCheckFailedException" });
    await expect(
      releaseProviderAccountLease(
        { doc: { send }, tables: { concurrencyLocks: "Locks" } } as never,
        { concurrencyId: "provider-lease:acct:0", sessionId: "sess", attemptId: "attempt" },
      ),
    ).resolves.toBeUndefined();
  });

  it("rethrows unexpected delete failures", async () => {
    const send = vi.fn().mockRejectedValue(new Error("boom"));
    await expect(
      releaseProviderAccountLease(
        { doc: { send }, tables: { concurrencyLocks: "Locks" } } as never,
        { concurrencyId: "provider-lease:acct:0", sessionId: "sess", attemptId: "attempt" },
      ),
    ).rejects.toThrow("boom");
  });

  it("atomically removes a timed-out session lease and its lock", async () => {
    const send = vi.fn().mockResolvedValue({});
    await expect(
      releaseTimedOutProviderAccountLease(
        {
          doc: { send },
          tables: { sessions: "Sessions", concurrencyLocks: "Locks" },
        } as never,
        { concurrencyId: "provider-lease:acct:0", sessionId: "sess", attemptId: "attempt" },
      ),
    ).resolves.toBe(true);
    const request = send.mock.calls[0]?.[0] as { input: { TransactItems: unknown[] } };
    const items = request.input.TransactItems;
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      Update: {
        UpdateExpression:
          "REMOVE providerAccountLease, timedOutHostId, timedOutAssignmentConnectionId, hostAssignmentLease",
      },
    });
    expect(items[1]).toMatchObject({ Delete: { TableName: "Locks" } });
  });

  it("returns false for a conditional timeout cleanup conflict", async () => {
    const send = vi.fn().mockRejectedValue({
      name: "TransactionCanceledException",
      CancellationReasons: [{ Code: "ConditionalCheckFailed" }],
    });
    await expect(
      releaseTimedOutProviderAccountLease(
        {
          doc: { send },
          tables: { sessions: "Sessions", concurrencyLocks: "Locks" },
        } as never,
        { concurrencyId: "provider-lease:acct:0", sessionId: "sess", attemptId: "attempt" },
      ),
    ).resolves.toBe(false);
  });

  it("releases a timeout-preserved host assignment lease in the same transaction", async () => {
    const send = vi.fn().mockResolvedValue({});
    await expect(
      releaseTimedOutProviderAccountLease(
        {
          doc: { send },
          tables: { sessions: "Sessions", concurrencyLocks: "Locks", hostLocks: "Hosts" },
        } as never,
        {
          concurrencyId: "provider-lease:acct:0",
          sessionId: "sess",
          attemptId: "attempt",
          hostAssignmentLease: { hostId: "host" },
        },
      ),
    ).resolves.toBe(true);
    const request = send.mock.calls[0]?.[0] as { input: { TransactItems: unknown[] } };
    expect(request.input.TransactItems).toHaveLength(3);
    expect(request.input.TransactItems[2]).toMatchObject({ Update: { TableName: "Hosts" } });
  });

  it("rethrows unexpected timeout cleanup failures", async () => {
    const send = vi.fn().mockRejectedValue(new Error("capacity unavailable"));
    await expect(
      releaseTimedOutProviderAccountLease(
        {
          doc: { send },
          tables: { sessions: "Sessions", concurrencyLocks: "Locks" },
        } as never,
        { concurrencyId: "provider-lease:acct:0", sessionId: "sess", attemptId: "attempt" },
      ),
    ).rejects.toThrow("capacity unavailable");
  });

  it("atomically releases a timeout-preserved host slot without a provider lease", async () => {
    const send = vi.fn().mockResolvedValue({});
    await expect(
      releaseTimedOutHostAssignment(
        { doc: { send }, tables: { sessions: "Sessions", hostLocks: "Hosts" } } as never,
        {
          sessionId: "sess",
          attemptId: "attempt",
          hostId: "host",
          hostAssignmentLease: { hostId: "host" },
        },
      ),
    ).resolves.toBe(true);
    const request = send.mock.calls[0]?.[0] as { input: { TransactItems: unknown[] } } | undefined;
    expect(request).toBeDefined();
    const items = request!.input.TransactItems;
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ Update: { TableName: "Sessions" } });
    expect(items[1]).toMatchObject({ Update: { TableName: "Hosts" } });
  });

  it("clears legacy timeout metadata without manufacturing host occupancy", async () => {
    const send = vi.fn().mockResolvedValue({});
    await expect(
      releaseTimedOutHostAssignment(
        { doc: { send }, tables: { sessions: "Sessions", hostLocks: "Hosts" } } as never,
        { sessionId: "sess", attemptId: "attempt", hostId: "host" },
      ),
    ).resolves.toBe(true);
    const request = send.mock.calls[0]?.[0] as { input: { TransactItems: unknown[] } };
    expect(request.input.TransactItems).toHaveLength(1);
    expect(request.input.TransactItems[0]).toMatchObject({
      Update: {
        TableName: "Sessions",
        UpdateExpression:
          "REMOVE timedOutHostId, timedOutAssignmentConnectionId, hostAssignmentLease",
      },
    });
  });

  it("omits transact deletes when no lease is held", () => {
    expect(providerAccountLeaseDeleteItems("Locks", "sess", undefined)).toEqual([]);
    expect(
      providerAccountLeaseDeleteItems("Locks", "sess", {
        concurrencyId: "provider-lease:acct:0",
        attemptId: "attempt",
        providerAccountId: "acct",
        slot: 0,
      }),
    ).toHaveLength(1);
  });

  it("backfills a legacy session and lease in one fenced transaction", async () => {
    const send = vi.fn().mockResolvedValue({});
    const result = await backfillProviderAccountLease(
      {
        doc: { send },
        tables: { sessions: "Sessions", providerAccounts: "Accounts", concurrencyLocks: "Locks" },
      } as never,
      {
        sessionId: "session",
        attemptId: "attempt",
        hostId: "host",
        providerAccountId: "acct",
        providerId: "provider",
        slot: 0,
      },
    );
    expect(result).toEqual({
      status: "migrated",
      lease: {
        concurrencyId: "provider-lease:acct:0",
        providerAccountId: "acct",
        slot: 0,
        attemptId: "attempt",
      },
    });
    const request = send.mock.calls[0]?.[0] as { input: { TransactItems: unknown[] } };
    expect(request.input.TransactItems).toHaveLength(3);
    expect(request.input.TransactItems[1]).toMatchObject({
      Update: {
        ConditionExpression: expect.stringContaining("attribute_not_exists(providerAccountLease)"),
      },
    });
    expect(request.input.TransactItems[2]).toMatchObject({
      Put: { ConditionExpression: "attribute_not_exists(concurrencyId)" },
    });
  });

  it("caps the provider account ConditionCheck at maxConcurrentSessions", async () => {
    const send = vi.fn().mockResolvedValue({});
    await backfillProviderAccountLease(
      {
        doc: { send },
        tables: { sessions: "Sessions", providerAccounts: "Accounts", concurrencyLocks: "Locks" },
      } as never,
      {
        sessionId: "session",
        attemptId: "attempt",
        hostId: "host",
        providerAccountId: "acct",
        slot: 1,
      },
    );
    const request = send.mock.calls[0]?.[0] as { input: { TransactItems: unknown[] } };
    expect(request.input.TransactItems[0]).toMatchObject({
      ConditionCheck: {
        TableName: "Accounts",
        ConditionExpression: expect.stringContaining(
          "(attribute_not_exists(maxConcurrentSessions) AND :slot < :defaultCap) OR maxConcurrentSessions > :slot",
        ),
        ExpressionAttributeValues: { ":slot": 1, ":defaultCap": DEFAULT_MAX_CONCURRENT_SESSIONS },
      },
    });
  });

  it("reports a competing lease without treating it as a migration", async () => {
    const send = vi.fn().mockRejectedValue({
      name: "TransactionCanceledException",
      CancellationReasons: [{ Code: "None" }, { Code: "None" }, { Code: "ConditionalCheckFailed" }],
    });
    await expect(
      backfillProviderAccountLease(
        {
          doc: { send },
          tables: { sessions: "Sessions", providerAccounts: "Accounts", concurrencyLocks: "Locks" },
        } as never,
        {
          sessionId: "session",
          attemptId: "attempt",
          hostId: "host",
          providerAccountId: "acct",
          slot: 0,
        },
      ),
    ).resolves.toEqual({ status: "lease_collision" });
  });

  it("reports a fenced session when its condition loses", async () => {
    const send = vi.fn().mockRejectedValue({
      name: "TransactionCanceledException",
      CancellationReasons: [{ Code: "None" }, { Code: "ConditionalCheckFailed" }, { Code: "None" }],
    });
    await expect(
      backfillProviderAccountLease(
        {
          doc: { send },
          tables: { sessions: "Sessions", providerAccounts: "Accounts", concurrencyLocks: "Locks" },
        } as never,
        {
          sessionId: "session",
          attemptId: "attempt",
          hostId: "host",
          providerAccountId: "acct",
          slot: 0,
        },
      ),
    ).resolves.toEqual({ status: "session_changed" });
  });

  it("rethrows non-conditional transaction failures", async () => {
    const send = vi.fn().mockRejectedValue(new Error("capacity unavailable"));
    await expect(
      backfillProviderAccountLease(
        {
          doc: { send },
          tables: { sessions: "Sessions", providerAccounts: "Accounts", concurrencyLocks: "Locks" },
        } as never,
        {
          sessionId: "session",
          attemptId: "attempt",
          hostId: "host",
          providerAccountId: "acct",
          slot: 0,
        },
      ),
    ).rejects.toThrow("capacity unavailable");
  });
});

describe("DynamoDB Local: forceReleaseProviderAccountLease", () => {
  let client: DynamoDBClient;
  let tables: DynamoTableNames;
  let ctx: PlaneStorageCtx;

  beforeAll(async () => {
    const clients = createDynamoClients();
    client = clients.client;
    tables = await ensureControlPlaneTables({ client, prefix: `AhLeaseRelease${process.pid}` });
    ctx = { doc: clients.doc, tables };
    await ctx.doc.send(
      new PutCommand({
        TableName: tables.providerAccounts,
        Item: {
          id: "acct",
          providerId: "provider",
          label: "account",
          createdAt: "now",
          updatedAt: "now",
        },
      }),
    );
  });

  afterAll(async () => {
    await Promise.all(
      Object.values(tables).map((TableName) => client.send(new DeleteTableCommand({ TableName }))),
    );
  });

  async function putLease(
    sessionId: string,
    slot: number,
    status: "cancelled" | "running",
    patch: Record<string, unknown> = {},
  ): Promise<void> {
    const attemptId = `${sessionId}-attempt`;
    const concurrencyId = `provider-lease:acct:${String(slot)}`;
    await putSession(ctx, {
      id: sessionId,
      repositoryId: "repo",
      prompt: "prompt",
      target: { commandId: "command" },
      fallbacks: [],
      targetLabels: ["command"],
      queueTtlSeconds: 60,
      queueExpiresAt: "2026-01-01T01:00:00.000Z",
      timeout: 60,
      priority: 0,
      requiredLabels: [],
      status,
      queueShard: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      hostId: "host",
      attemptId,
      providerAccountLease: { concurrencyId, providerAccountId: "acct", slot, attemptId },
      ...patch,
    });
    await ctx.doc.send(
      new PutCommand({
        TableName: tables.concurrencyLocks,
        Item: { concurrencyId, providerAccountId: "acct", slot, sessionId, attemptId },
      }),
    );
  }

  async function readLeaseRows(sessionId: string, slot: number) {
    const [session, lock] = await Promise.all([
      ctx.doc.send(
        new GetCommand({
          TableName: tables.sessions,
          Key: { id: sessionId },
          ConsistentRead: true,
        }),
      ),
      ctx.doc.send(
        new GetCommand({
          TableName: tables.concurrencyLocks,
          Key: { concurrencyId: `provider-lease:acct:${String(slot)}` },
          ConsistentRead: true,
        }),
      ),
    ]);
    return { session: session.Item, lock: lock.Item };
  }

  it("lists and atomically releases a terminal attempt-owned lease", async () => {
    await putLease("terminal", 4, "cancelled");
    const locks = await listProviderAccountLeaseLocks(ctx, "acct", 8);
    expect(locks).toContainEqual(
      expect.objectContaining({ sessionId: "terminal", slot: 4, attemptId: "terminal-attempt" }),
    );
    const holders = await getProviderAccountLeaseHolderSessions(ctx, locks);
    expect(holders.get("terminal")?.status).toBe("cancelled");

    await expect(
      forceReleaseProviderAccountLease(ctx, {
        providerAccountId: "acct",
        slot: 4,
        concurrencyId: "provider-lease:acct:4",
        sessionId: "terminal",
        attemptId: "terminal-attempt",
      }),
    ).resolves.toBe(true);
    const rows = await readLeaseRows("terminal", 4);
    expect(rows.session).not.toHaveProperty("providerAccountLease");
    expect(rows.lock).toBeUndefined();
  });

  it("leaves both rows intact for stale attempts and active sessions", async () => {
    await putLease("terminal-stale", 5, "cancelled");
    await expect(
      forceReleaseProviderAccountLease(ctx, {
        providerAccountId: "acct",
        slot: 5,
        concurrencyId: "provider-lease:acct:5",
        sessionId: "terminal-stale",
        attemptId: "stale-attempt",
      }),
    ).resolves.toBe(false);
    expect(await readLeaseRows("terminal-stale", 5)).toMatchObject({
      session: { providerAccountLease: { attemptId: "terminal-stale-attempt" } },
      lock: { attemptId: "terminal-stale-attempt" },
    });

    await putLease("active", 6, "running");
    await expect(
      forceReleaseProviderAccountLease(ctx, {
        providerAccountId: "acct",
        slot: 6,
        concurrencyId: "provider-lease:acct:6",
        sessionId: "active",
        attemptId: "active-attempt",
      }),
    ).resolves.toBe(false);
    expect(await readLeaseRows("active", 6)).toMatchObject({
      session: { providerAccountLease: { attemptId: "active-attempt" } },
      lock: { attemptId: "active-attempt" },
    });
  });

  it("releases a legacy resolved-route attempt but not an attached terminal assignment", async () => {
    await putLease("legacy", 7, "cancelled", {
      attemptId: undefined,
      resolvedRoute: {
        targetIndex: 0,
        commandId: "command",
        hostId: "host",
        worktreeId: null,
        attemptId: "legacy-attempt",
      },
      providerAccountLease: {
        concurrencyId: "provider-lease:acct:7",
        providerAccountId: "acct",
        slot: 7,
        attemptId: "legacy-attempt",
      },
    });
    await ctx.doc.send(
      new PutCommand({
        TableName: tables.concurrencyLocks,
        Item: {
          concurrencyId: "provider-lease:acct:7",
          providerAccountId: "acct",
          slot: 7,
          sessionId: "legacy",
          attemptId: "legacy-attempt",
        },
      }),
    );
    await expect(
      forceReleaseProviderAccountLease(ctx, {
        providerAccountId: "acct",
        slot: 7,
        concurrencyId: "provider-lease:acct:7",
        sessionId: "legacy",
        attemptId: "legacy-attempt",
      }),
    ).resolves.toBe(true);
    expect(await readLeaseRows("legacy", 7)).toMatchObject({ lock: undefined });

    await putLease("attached", 8, "cancelled", {
      worktreeId: "worktree",
      assignmentConnectionId: "connection",
    });
    await expect(
      forceReleaseProviderAccountLease(ctx, {
        providerAccountId: "acct",
        slot: 8,
        concurrencyId: "provider-lease:acct:8",
        sessionId: "attached",
        attemptId: "attached-attempt",
      }),
    ).resolves.toBe(false);
    expect(await readLeaseRows("attached", 8)).toMatchObject({
      session: { providerAccountLease: { attemptId: "attached-attempt" } },
      lock: { attemptId: "attached-attempt" },
    });
  });
});

describe("DynamoDB Local: backfillProviderAccountLease cancellation fence", () => {
  let client: DynamoDBClient;
  let tables: DynamoTableNames;
  let ctx: PlaneStorageCtx;
  const session = {
    repositoryId: "repo",
    prompt: "prompt",
    target: { commandId: "command" },
    fallbacks: [],
    targetDisplayNames: ["command"],
    queueTtlSeconds: 60,
    queueExpiresAt: "2026-01-01T01:00:00.000Z",
    timeout: 60,
    priority: 0,
    requiredLabels: [],
    status: "cancelled" as const,
    queueShard: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    hostId: "host",
    attemptId: "attempt",
    resolvedRoute: {
      targetIndex: 0,
      commandId: "command",
      hostId: "host",
      worktreeId: null,
      attemptId: "attempt",
      providerAccountId: "acct",
    },
  };

  beforeAll(async () => {
    const clients = createDynamoClients();
    client = clients.client;
    tables = await ensureControlPlaneTables({ client, prefix: `AhLeaseFence${process.pid}` });
    ctx = { doc: clients.doc, tables };
    await ctx.doc.send(
      new PutCommand({
        TableName: tables.providerAccounts,
        Item: {
          id: "acct",
          providerId: "provider",
          name: "acct",
          createdAt: "now",
          updatedAt: "now",
          // Above the default cap: this suite's cases occupy slots 0-1 across two
          // distinct sessions; the cap boundary itself is covered separately below.
          maxConcurrentSessions: 2,
        },
      }),
    );
  });
  afterAll(async () => {
    await Promise.all(
      Object.values(tables).map((TableName) => client.send(new DeleteTableCommand({ TableName }))),
    );
  });

  it("migrates a cancelled session still holding a live worktreeId claim", async () => {
    await putSession(ctx, { ...session, id: "mid-release", worktreeId: "worktree" });
    await expect(
      backfillProviderAccountLease(ctx, {
        sessionId: "mid-release",
        attemptId: "attempt",
        hostId: "host",
        providerAccountId: "acct",
        slot: 0,
      }),
    ).resolves.toMatchObject({ status: "migrated" });
  });

  it("migrates a cancelled session still holding a live mainCheckoutLease claim", async () => {
    await putSession(ctx, { ...session, id: "mid-release-main", mainCheckoutLease: true });
    await expect(
      backfillProviderAccountLease(ctx, {
        sessionId: "mid-release-main",
        attemptId: "attempt",
        hostId: "host",
        providerAccountId: "acct",
        slot: 1,
      }),
    ).resolves.toMatchObject({ status: "migrated" });
  });

  it("refuses a cancelled session whose worktreeId was released to explicit NULL", async () => {
    await putSession(ctx, { ...session, id: "released", worktreeId: null });
    await expect(
      backfillProviderAccountLease(ctx, {
        sessionId: "released",
        attemptId: "attempt",
        hostId: "host",
        providerAccountId: "acct",
        slot: 2,
      }),
    ).resolves.toEqual({ status: "session_changed" });
  });

  it("refuses a cancelled session that never held either mid-release claim", async () => {
    await putSession(ctx, { ...session, id: "never-mid-release" });
    await expect(
      backfillProviderAccountLease(ctx, {
        sessionId: "never-mid-release",
        attemptId: "attempt",
        hostId: "host",
        providerAccountId: "acct",
        slot: 3,
      }),
    ).resolves.toEqual({ status: "session_changed" });
  });
});

describe("DynamoDB Local: backfillProviderAccountLease maxConcurrentSessions cap", () => {
  let client: DynamoDBClient;
  let tables: DynamoTableNames;
  let ctx: PlaneStorageCtx;
  const session = {
    repositoryId: "repo",
    prompt: "prompt",
    target: { commandId: "command" },
    fallbacks: [],
    targetDisplayNames: ["command"],
    queueTtlSeconds: 60,
    queueExpiresAt: "2026-01-01T01:00:00.000Z",
    timeout: 60,
    priority: 0,
    requiredLabels: [],
    status: "running" as const,
    queueShard: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    hostId: "host",
    attemptId: "attempt",
  };

  beforeAll(async () => {
    const clients = createDynamoClients();
    client = clients.client;
    tables = await ensureControlPlaneTables({ client, prefix: `AhLeaseCap${process.pid}` });
    ctx = { doc: clients.doc, tables };
    await ctx.doc.send(
      new PutCommand({
        TableName: tables.providerAccounts,
        Item: {
          id: "acct-default",
          providerId: "provider",
          name: "acct-default",
          createdAt: "now",
          updatedAt: "now",
          // maxConcurrentSessions intentionally omitted: legacy rows fall back to
          // DEFAULT_MAX_CONCURRENT_SESSIONS.
        },
      }),
    );
    await ctx.doc.send(
      new PutCommand({
        TableName: tables.providerAccounts,
        Item: {
          id: "acct-2",
          providerId: "provider",
          name: "acct-2",
          createdAt: "now",
          updatedAt: "now",
          maxConcurrentSessions: 2,
        },
      }),
    );
  });
  afterAll(async () => {
    await Promise.all(
      Object.values(tables).map((TableName) => client.send(new DeleteTableCommand({ TableName }))),
    );
  });

  it("migrates a slot within the default cap when maxConcurrentSessions is unset", async () => {
    await putSession(ctx, {
      ...session,
      id: "default-cap-ok",
      resolvedRoute: {
        targetIndex: 0,
        commandId: "command",
        hostId: "host",
        worktreeId: null,
        attemptId: "attempt",
        providerAccountId: "acct-default",
      },
    });
    await expect(
      backfillProviderAccountLease(ctx, {
        sessionId: "default-cap-ok",
        attemptId: "attempt",
        hostId: "host",
        providerAccountId: "acct-default",
        slot: 0,
      }),
    ).resolves.toMatchObject({ status: "migrated" });
  });

  it("refuses a slot at the default cap when maxConcurrentSessions is unset", async () => {
    await putSession(ctx, {
      ...session,
      id: "default-cap-over",
      resolvedRoute: {
        targetIndex: 0,
        commandId: "command",
        hostId: "host",
        worktreeId: null,
        attemptId: "attempt",
        providerAccountId: "acct-default",
      },
    });
    await expect(
      backfillProviderAccountLease(ctx, {
        sessionId: "default-cap-over",
        attemptId: "attempt",
        hostId: "host",
        providerAccountId: "acct-default",
        slot: DEFAULT_MAX_CONCURRENT_SESSIONS,
      }),
    ).resolves.toEqual({ status: "session_changed" });
  });

  it("migrates a slot within an explicit maxConcurrentSessions cap", async () => {
    await putSession(ctx, {
      ...session,
      id: "explicit-cap-ok",
      resolvedRoute: {
        targetIndex: 0,
        commandId: "command",
        hostId: "host",
        worktreeId: null,
        attemptId: "attempt",
        providerAccountId: "acct-2",
      },
    });
    await expect(
      backfillProviderAccountLease(ctx, {
        sessionId: "explicit-cap-ok",
        attemptId: "attempt",
        hostId: "host",
        providerAccountId: "acct-2",
        slot: 1,
      }),
    ).resolves.toMatchObject({ status: "migrated" });
  });

  it("refuses a slot at an explicit maxConcurrentSessions cap", async () => {
    await putSession(ctx, {
      ...session,
      id: "explicit-cap-over",
      resolvedRoute: {
        targetIndex: 0,
        commandId: "command",
        hostId: "host",
        worktreeId: null,
        attemptId: "attempt",
        providerAccountId: "acct-2",
      },
    });
    await expect(
      backfillProviderAccountLease(ctx, {
        sessionId: "explicit-cap-over",
        attemptId: "attempt",
        hostId: "host",
        providerAccountId: "acct-2",
        slot: 2,
      }),
    ).resolves.toEqual({ status: "session_changed" });
  });
});
