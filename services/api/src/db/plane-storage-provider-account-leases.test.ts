import { describe, expect, it, vi } from "vitest";

import {
  backfillProviderAccountLease,
  providerAccountLeaseDeleteItems,
  releaseProviderAccountLease,
  releaseTimedOutProviderAccountLease,
} from "./plane-storage-provider-account-leases.ts";
import { releaseTimedOutHostAssignment } from "./plane-storage-host-assignment.ts";

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
        UpdateExpression: "REMOVE providerAccountLease, timedOutHostId, hostAssignmentLease",
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

  it("atomically releases a timeout-preserved host slot without a provider lease", async () => {
    const send = vi.fn().mockResolvedValue({});
    await expect(
      releaseTimedOutHostAssignment(
        { doc: { send }, tables: { sessions: "Sessions", hostLocks: "Hosts" } } as never,
        { sessionId: "sess", attemptId: "attempt", hostId: "host" },
      ),
    ).resolves.toBe(true);
    const request = send.mock.calls[0]?.[0] as { input: { TransactItems: unknown[] } } | undefined;
    expect(request).toBeDefined();
    const items = request!.input.TransactItems;
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ Update: { TableName: "Sessions" } });
    expect(items[1]).toMatchObject({ Update: { TableName: "Hosts" } });
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
