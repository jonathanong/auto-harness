import { describe, expect, it, vi } from "vitest";

import {
  providerAccountLeaseDeleteItems,
  releaseProviderAccountLease,
} from "./plane-storage-provider-account-leases.ts";

describe("provider account lease storage", () => {
  it("deletes the attempt-owned lock and ignores a lost condition", async () => {
    const send = vi.fn().mockResolvedValue({});
    await releaseProviderAccountLease(
      { doc: { send }, tables: { concurrencyLocks: "Locks" } } as never,
      { concurrencyId: "provider-account:acct:0", sessionId: "sess", attemptId: "attempt" },
    );
    expect(send).toHaveBeenCalledOnce();
    send.mockRejectedValueOnce({ name: "ConditionalCheckFailedException" });
    await expect(
      releaseProviderAccountLease(
        { doc: { send }, tables: { concurrencyLocks: "Locks" } } as never,
        { concurrencyId: "provider-account:acct:0", sessionId: "sess", attemptId: "attempt" },
      ),
    ).resolves.toBeUndefined();
  });

  it("rethrows unexpected delete failures", async () => {
    const send = vi.fn().mockRejectedValue(new Error("boom"));
    await expect(
      releaseProviderAccountLease(
        { doc: { send }, tables: { concurrencyLocks: "Locks" } } as never,
        { concurrencyId: "provider-account:acct:0", sessionId: "sess", attemptId: "attempt" },
      ),
    ).rejects.toThrow("boom");
  });

  it("omits transact deletes when no lease is held", () => {
    expect(providerAccountLeaseDeleteItems("Locks", "sess", undefined)).toEqual([]);
    expect(
      providerAccountLeaseDeleteItems("Locks", "sess", {
        concurrencyId: "provider-account:acct:0",
        attemptId: "attempt",
        providerAccountId: "acct",
        slot: 0,
      }),
    ).toHaveLength(1);
  });
});
