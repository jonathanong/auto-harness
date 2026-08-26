/* eslint-disable max-lines -- provider lease storage cases share transaction fixtures. */
import { DeleteTableCommand, type DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createDynamoClients, type DynamoTableNames } from "./dynamo.ts";
import { ensureControlPlaneTables } from "./ensure-tables.ts";
import { releaseTimedOutHostAssignment } from "./plane-storage-host-assignment.ts";
import {
  backfillProviderAccountLease,
  providerAccountLeaseDeleteItems,
  releaseProviderAccountLease,
  releaseTimedOutProviderAccountLease,
} from "./plane-storage-provider-account-leases.ts";
import { putSession } from "./plane-storage-sessions.ts";
import type { PlaneStorageCtx } from "./plane-storage-types.ts";

describe("provider account lease storage", () => {
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

  it("fences the backfilled slot against the account's maxConcurrentSessions cap", async () => {
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
        providerId: "provider",
        slot: 2,
      },
    );
    const request = send.mock.calls[0]?.[0] as {
      input: {
        TransactItems: {
          ConditionCheck: {
            ConditionExpression: string;
            ExpressionAttributeValues: Record<string, unknown>;
          };
        }[];
      };
    };
    const conditionCheck = request.input.TransactItems[0].ConditionCheck;
    expect(conditionCheck.ConditionExpression).toContain(
      "((attribute_not_exists(maxConcurrentSessions) AND :slot < :defaultCap) OR maxConcurrentSessions > :slot)",
    );
    expect(conditionCheck.ConditionExpression).toContain("providerId = :providerId");
    expect(conditionCheck.ExpressionAttributeValues[":slot"]).toBe(2);
    expect(conditionCheck.ExpressionAttributeValues[":defaultCap"]).toBe(1);
    expect(conditionCheck.ExpressionAttributeValues[":providerId"]).toBe("provider");
  });

  it("omits the providerId fence when no providerId is given, but keeps the cap fence", async () => {
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
        slot: 0,
      },
    );
    const request = send.mock.calls[0]?.[0] as {
      input: {
        TransactItems: {
          ConditionCheck: {
            ConditionExpression: string;
            ExpressionAttributeValues: Record<string, unknown>;
          };
        }[];
      };
    };
    const conditionCheck = request.input.TransactItems[0].ConditionCheck;
    expect(conditionCheck.ConditionExpression).not.toContain("providerId");
    expect(conditionCheck.ExpressionAttributeValues).not.toHaveProperty(":providerId");
    expect(conditionCheck.ExpressionAttributeValues[":slot"]).toBe(0);
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

describe("DynamoDB Local: backfillProviderAccountLease cancellation fence", () => {
  let client: DynamoDBClient;
  let tables: DynamoTableNames;
  let ctx: PlaneStorageCtx;
  const session = {
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
          // High enough that slots 0-3 below stay within the cap fence added
          // for #345 and continue exercising only the cancellation fence.
          maxConcurrentSessions: 5,
          createdAt: "now",
          updatedAt: "now",
        },
      }),
    );
    await ctx.doc.send(
      new PutCommand({
        TableName: tables.providerAccounts,
        Item: {
          id: "acct-capped",
          providerId: "provider",
          name: "acct-capped",
          maxConcurrentSessions: 1,
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
    targetLabels: ["command"],
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
    resolvedRoute: {
      targetIndex: 0,
      commandId: "command",
      hostId: "host",
      worktreeId: null,
      attemptId: "attempt",
      providerAccountId: "acct-capped",
    },
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
          id: "acct-capped",
          providerId: "provider",
          name: "acct-capped",
          maxConcurrentSessions: 1,
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

  it("migrates a session into the last open slot under the cap", async () => {
    await putSession(ctx, { ...session, id: "within-cap" });
    await expect(
      backfillProviderAccountLease(ctx, {
        sessionId: "within-cap",
        attemptId: "attempt",
        hostId: "host",
        providerAccountId: "acct-capped",
        providerId: "provider",
        slot: 0,
      }),
    ).resolves.toMatchObject({ status: "migrated" });
  });

  it("refuses a slot at or beyond the account's maxConcurrentSessions cap", async () => {
    await putSession(ctx, { ...session, id: "over-cap" });
    await expect(
      backfillProviderAccountLease(ctx, {
        sessionId: "over-cap",
        attemptId: "attempt",
        hostId: "host",
        providerAccountId: "acct-capped",
        slot: 1,
      }),
    ).resolves.toEqual({ status: "session_changed" });
  });
});
