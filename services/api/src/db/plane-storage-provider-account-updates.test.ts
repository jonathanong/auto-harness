import { describe, expect, it, vi } from "vitest";

import { MAX_CONCURRENT_SESSIONS_LIMIT } from "@auto-harness/shared";
import {
  clearProviderAccountUsageLimit,
  updateProviderAccount,
} from "./plane-storage-provider-account-updates.ts";

const tables = {
  concurrencyLocks: "Locks",
  providerAccounts: "Accounts",
  providers: "Providers",
};

function updateOptions(over: Record<string, unknown> = {}) {
  return {
    id: "account",
    expectedVersion: 1,
    expectedMaxConcurrentSessions: 3,
    updatedAt: "now",
    patch: { maxConcurrentSessions: 1 },
    ...over,
  } as never;
}

describe("provider account update storage", () => {
  it("fences cap reductions and maps conditional and unexpected failures", async () => {
    const send = vi.fn(async () => ({}));
    const ctx = { doc: { send }, tables } as never;

    await expect(updateProviderAccount(ctx, updateOptions())).resolves.toBe(true);
    const transaction = send.mock.calls[0]![0] as { input: { TransactItems: unknown[] } };
    expect(transaction.input.TransactItems).toHaveLength(1 + (MAX_CONCURRENT_SESSIONS_LIMIT - 1));

    send.mockRejectedValueOnce({
      name: "TransactionCanceledException",
      CancellationReasons: [{ Code: "ConditionalCheckFailed" }],
    });
    await expect(updateProviderAccount(ctx, updateOptions())).resolves.toBe(false);

    send.mockRejectedValueOnce(new Error("throttled"));
    await expect(updateProviderAccount(ctx, updateOptions())).rejects.toThrow("throttled");

    send.mockRejectedValueOnce({});
    await expect(
      clearProviderAccountUsageLimit(ctx, {
        id: "account",
        expectedVersion: 1,
        updatedAt: "now",
      }),
    ).rejects.toEqual({});
  });

  it("covers provider moves with fences and missing source providers", async () => {
    const send = vi.fn(async () => ({ Item: { id: "provider", accountCount: 1 } }));
    const ctx = { doc: { send }, tables } as never;

    await expect(
      updateProviderAccount(
        ctx,
        updateOptions({ expectedProviderId: undefined, patch: { providerId: "new" } }),
      ),
    ).resolves.toBe(false);

    send.mockClear();
    await expect(
      updateProviderAccount(
        ctx,
        updateOptions({
          expectedProviderId: "old",
          expectedMaxConcurrentSessions: 2,
          patch: { providerId: "new", maxConcurrentSessions: 1 },
        }),
      ),
    ).resolves.toBe(true);
    const transaction = send.mock.calls.at(-1)?.[0] as { input: { TransactItems: unknown[] } };
    expect(transaction.input.TransactItems).toHaveLength(3 + (MAX_CONCURRENT_SESSIONS_LIMIT - 1));

    send.mockReset();
    send
      .mockResolvedValueOnce({ Item: { id: "old", accountCount: 1 } })
      .mockResolvedValueOnce({ Item: { id: "new", accountCount: 1 } })
      .mockRejectedValueOnce(new Error("move failed"));
    await expect(
      updateProviderAccount(
        ctx,
        updateOptions({ expectedProviderId: "old", patch: { providerId: "new" } }),
      ),
    ).rejects.toThrow("move failed");

    send.mockReset();
    send
      .mockResolvedValueOnce({ Item: { id: "old", accountCount: 1 } })
      .mockResolvedValueOnce({ Item: { id: "new", accountCount: 1 } })
      .mockRejectedValueOnce({
        name: "TransactionCanceledException",
        CancellationReasons: [{ Code: "ConditionalCheckFailed" }],
      });
    await expect(
      updateProviderAccount(
        ctx,
        updateOptions({ expectedProviderId: "old", patch: { providerId: "new" } }),
      ),
    ).resolves.toBe(false);

    send.mockReset();
    send.mockResolvedValueOnce({});
    await expect(
      updateProviderAccount(
        ctx,
        updateOptions({ expectedProviderId: "old", patch: { providerId: "new" } }),
      ),
    ).resolves.toBe(false);

    send.mockReset();
    send.mockResolvedValueOnce({ Item: { id: "old", accountCount: 1 } }).mockResolvedValueOnce({});
    await expect(
      updateProviderAccount(
        ctx,
        updateOptions({ expectedProviderId: "old", patch: { providerId: "new" } }),
      ),
    ).resolves.toBe(false);
  });

  it("covers cooldown conditions, version zero, and conditional failures", async () => {
    const send = vi.fn(async () => ({}));
    const ctx = { doc: { send }, tables } as never;

    await expect(
      clearProviderAccountUsageLimit(ctx, {
        id: "account",
        expectedVersion: 0,
        updatedAt: "now",
      }),
    ).resolves.toBe(true);
    await expect(
      clearProviderAccountUsageLimit(ctx, {
        id: "account",
        expectedVersion: 2,
        expectedUsageLimitedUntil: null,
        updatedAt: "now",
      }),
    ).resolves.toBe(true);
    send.mockRejectedValueOnce({ name: "ConditionalCheckFailedException" });
    await expect(
      clearProviderAccountUsageLimit(ctx, {
        id: "account",
        expectedVersion: 2,
        updatedAt: "now",
      }),
    ).resolves.toBe(false);
    send.mockRejectedValueOnce({ name: "TransactionCanceledException", CancellationReasons: [] });
    await expect(
      clearProviderAccountUsageLimit(ctx, {
        id: "account",
        expectedVersion: 2,
        updatedAt: "now",
      }),
    ).rejects.toMatchObject({ name: "TransactionCanceledException" });
    send.mockRejectedValueOnce({ name: "TransactionCanceledException" });
    await expect(
      clearProviderAccountUsageLimit(ctx, {
        id: "account",
        expectedVersion: 2,
        updatedAt: "now",
      }),
    ).rejects.toMatchObject({ name: "TransactionCanceledException" });
  });
});
