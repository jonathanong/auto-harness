import { describe, expect, it } from "vitest";

import { deleteAuthAccountFenced } from "./plane-storage-auth.ts";
import type { PlaneStorageCtx } from "./plane-storage-types.ts";

function ctx(send: (command: { input?: Record<string, unknown> }) => Promise<unknown>) {
  return {
    doc: { send },
    tables: { users: "users", concurrencyLocks: "locks" },
  } as unknown as PlaneStorageCtx;
}

const marker = { key: "principal:user:alice", owner: "owner", now: "2026-08-23T00:00:00.000Z" };

function cancelledAt(index: number) {
  return {
    name: "TransactionCanceledException",
    CancellationReasons: [
      { Code: index === 0 ? "ConditionalCheckFailed" : "None" },
      { Code: index === 1 ? "ConditionalCheckFailed" : "None" },
    ],
  };
}

describe("fenced auth-account deletion", () => {
  it("deletes only while the exact principal deletion marker remains owned", async () => {
    let input: Record<string, unknown> | undefined;
    await expect(
      deleteAuthAccountFenced(
        ctx(async (command) => {
          input = command.input;
          return {};
        }),
        "user:alice",
        marker,
      ),
    ).resolves.toBe("deleted");
    expect(input).toMatchObject({
      TransactItems: [
        {
          ConditionCheck: {
            TableName: "locks",
            Key: { concurrencyId: "catalog-delete:principal:user:alice" },
            ConditionExpression: "deletionOwner = :owner AND expiresAt > :now",
          },
        },
        {
          Delete: {
            TableName: "users",
            Key: { id: "user:alice" },
            ConditionExpression: "attribute_exists(id)",
          },
        },
      ],
    });
  });

  it("does not evict the local cache when the fence or account row is gone", async () => {
    await expect(
      deleteAuthAccountFenced(
        ctx(async () => Promise.reject(cancelledAt(0))),
        "user:alice",
        marker,
      ),
    ).resolves.toBe("fence-lost");
    await expect(
      deleteAuthAccountFenced(
        ctx(async () => Promise.reject(cancelledAt(1))),
        "user:alice",
        marker,
      ),
    ).resolves.toBe("missing");
  });
});
