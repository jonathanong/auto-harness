import { describe, expect, it } from "vitest";

import { createDynamoTestCtx } from "./dynamo-test-helpers.ts";

const ctx = createDynamoTestCtx("Auth");

describe("DynamoDB Local auth storage", () => {
  it("updates user passwords with compare-and-swap semantics", async () => {
    if (!ctx.available || !ctx.storage) {
      expect(true).toBe(true);
      return;
    }
    const storage = ctx.storage;
    await storage.putAuthAccount({
      id: "user:alice",
      username: "alice",
      kind: "user",
      role: "operator",
      passwordHash: "before",
      createdAt: "t",
      updatedAt: "t",
    });
    expect(await storage.updateAuthAccountPassword("user:alice", "before", "after", "t2")).toBe(
      true,
    );
    expect((await storage.getAuthAccount("user:alice"))?.passwordHash).toBe("after");
    expect((await storage.getAuthAccount("user:alice"))?.updatedAt).toBe("t2");
    expect(await storage.updateAuthAccountPassword("user:alice", "before", "later", "t3")).toBe(
      false,
    );
    expect(await storage.updateAuthAccountPassword("missing-user", "before", "after", "t2")).toBe(
      false,
    );
  });
});
