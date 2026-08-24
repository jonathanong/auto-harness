import { describe, expect, it, vi } from "vitest";

import {
  backfillProviderAccountLease,
  providerAccountLeaseDeleteItems,
  releaseProviderAccountLease,
} from "./plane-storage-provider-account-leases.ts";

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
});
