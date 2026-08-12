import { describe, expect, it } from "vitest";

import { createDynamoTestCtx } from "./dynamo-test-helpers.ts";

const ctx = createDynamoTestCtx("ClearAuth");

describe("DynamoDB Local clearAll auth accounts", () => {
  it("removes persisted Users records", async () => {
    if (!ctx.available || !ctx.storage) {
      expect(true).toBe(true);
      return;
    }

    const account = {
      id: "clear-auth-user",
      username: "clear-auth-user",
      kind: "user" as const,
      role: "admin" as const,
      passwordHash: "hash",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    await ctx.storage.putAuthAccount(account);
    expect(await ctx.storage.getAuthAccount(account.id)).toMatchObject(account);

    await ctx.storage.clearAll();

    await expect(ctx.storage.getAuthAccount(account.id)).resolves.toBeNull();
  });
});
