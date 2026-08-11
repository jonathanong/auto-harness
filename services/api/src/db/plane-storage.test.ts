import { describe, expect, it } from "vitest";

import { createDynamoTestCtx } from "./dynamo-test-helpers.ts";

const ctx = createDynamoTestCtx("StoCore");

describe("DynamoPlaneStorage catalog delegators", () => {
  it("persists provider catalogs, accounts, commands, and clearAll through DynamoDB Local", async () => {
    expect(ctx.storage).not.toBeNull();
    const storage = ctx.storage!;
    const now = "2026-01-01T00:00:00.000Z";

    await storage.putProvider({
      id: "provider",
      name: "Codex",
      defaultCommandId: null,
      createdAt: now,
      updatedAt: now,
    });
    expect(await storage.getProvider("provider")).toMatchObject({ name: "Codex" });
    expect(await storage.listProviders()).toHaveLength(1);

    expect(
      await storage.putProviderAccount({
        id: "account",
        providerId: "provider",
        label: "account@example.test",
        usageLimitCooldownSeconds: 60,
        usageLimitedUntil: null,
        lastUsageLimitedAt: null,
        lastAssignedAt: null,
        createdAt: now,
        updatedAt: now,
      }),
    ).toBe(true);
    expect(await storage.getProviderAccount("account")).toMatchObject({
      label: "account@example.test",
      version: 1,
    });
    expect(await storage.listProviderAccounts()).toHaveLength(1);
    expect(
      await storage.updateProviderAccount({
        id: "account",
        expectedVersion: 1,
        expectedProviderId: "provider",
        updatedAt: now,
        patch: { label: "renamed@example.test" },
      }),
    ).toBe(true);
    expect(
      await storage.clearProviderAccountUsageLimit({
        id: "account",
        expectedVersion: 2,
        expectedUsageLimitedUntil: null,
        updatedAt: now,
      }),
    ).toBe(true);
    expect(await storage.deleteProviderAccount("account")).toBe(true);

    await storage.putCommand({
      id: "command",
      name: "echo",
      argv: ["echo"],
      appendPrompt: true,
      providerId: null,
      createdAt: now,
      updatedAt: now,
    });
    expect(await storage.getCommand("command")).toMatchObject({ argv: ["echo"] });
    expect(await storage.listCommands()).toHaveLength(1);
    await storage.deleteCommand("command");
    expect(await storage.getCommand("command")).toBeNull();

    expect(await storage.deleteProvider("provider")).toBe(true);
    await storage.clearAll();
    expect(await storage.listProviders()).toEqual([]);
  });
});
