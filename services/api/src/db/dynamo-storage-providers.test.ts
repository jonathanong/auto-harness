import { describe, expect, it, vi } from "vitest";

import { createDynamoTestCtx } from "./dynamo-test-helpers.ts";
import {
  clearProviderAccountUsageLimit,
  updateProviderAccount,
} from "./plane-storage-catalog-providers.ts";
import type { PlaneStorageCtx } from "./plane-storage-types.ts";

const ctx = createDynamoTestCtx("StoPr");

describe("DynamoDB Local storage — providers/provider-accounts/commands", () => {
  it("persists providers, provider accounts, and commands", async () => {
    if (!ctx.available || !ctx.storage) {
      expect(true).toBe(true);
      return;
    }
    const s = ctx.storage;

    await s.putProvider({
      id: "prov-1",
      name: "claude",
      defaultCommandId: null,
      createdAt: "t",
      updatedAt: "t",
    });
    expect((await s.getProvider("prov-1"))?.name).toBe("claude");
    expect(await s.getProvider("nope")).toBeNull();
    expect((await s.listProviders()).length).toBeGreaterThan(0);

    await s.putProviderAccount({
      id: "acct-1",
      providerId: "prov-1",
      label: "jonathanrichardong@gmail.com",
      createdAt: "t",
      updatedAt: "t",
    });
    expect((await s.getProviderAccount("acct-1"))?.providerId).toBe("prov-1");
    expect(await s.getProviderAccount("nope")).toBeNull();
    expect((await s.listProviderAccounts()).length).toBeGreaterThan(0);

    const accountBeforeEdit = await s.getProviderAccount("acct-1");
    expect(
      await s.updateProviderAccount({
        id: "acct-1",
        expectedUpdatedAt: accountBeforeEdit?.updatedAt ?? "",
        updatedAt: "t2",
        patch: { label: "updated@example.com" },
      }),
    ).toBe(true);
    expect((await s.getProviderAccount("acct-1"))?.label).toBe("updated@example.com");

    // A stale clear cannot erase a newer account version, and a stale update
    // cannot recreate an account deleted by another control-plane process.
    expect(
      await s.clearProviderAccountUsageLimit({
        id: "acct-1",
        expectedUpdatedAt: accountBeforeEdit?.updatedAt ?? "",
        updatedAt: "t3",
      }),
    ).toBe(false);

    await s.putCommand({
      id: "cmd-1",
      name: "claude-print",
      argv: ["claude", "-p"],
      appendPrompt: true,
      providerId: "prov-1",
      createdAt: "t",
      updatedAt: "t",
    });
    expect((await s.getCommand("cmd-1"))?.argv).toEqual(["claude", "-p"]);
    expect(await s.getCommand("nope")).toBeNull();
    expect((await s.listCommands()).length).toBeGreaterThan(0);

    await s.deleteProvider("prov-1");
    expect(await s.getProvider("prov-1")).toBeNull();
    await s.deleteProviderAccount("acct-1");
    expect(await s.getProviderAccount("acct-1")).toBeNull();
    expect(
      await s.updateProviderAccount({
        id: "acct-1",
        expectedUpdatedAt: "t2",
        updatedAt: "t4",
        patch: { label: "must-not-revive" },
      }),
    ).toBe(false);
    await s.deleteCommand("cmd-1");
    expect(await s.getCommand("cmd-1")).toBeNull();
  });

  it("uses field-level conditional updates for account edits and clears", async () => {
    const sent: Array<{ input?: Record<string, unknown> }> = [];
    let conditionalFailure = false;
    const fakeCtx = {
      tables: { providerAccounts: "ProviderAccounts" },
      doc: {
        send: vi.fn(async (command: { input?: Record<string, unknown> }) => {
          sent.push(command);
          if (conditionalFailure) throw { name: "ConditionalCheckFailedException" };
          return {};
        }),
      },
    } as unknown as PlaneStorageCtx;

    expect(
      await updateProviderAccount(fakeCtx, {
        id: "acct-1",
        expectedUpdatedAt: "t1",
        updatedAt: "t2",
        patch: {
          providerId: "prov-1",
          label: "a",
          usageLimitCooldownSeconds: 10,
          usageLimitedUntil: null,
        },
      }),
    ).toBe(true);
    expect(sent[0]?.input?.UpdateExpression).toContain("SET updatedAt = :updatedAt");
    expect(sent[0]?.input?.UpdateExpression).toContain("REMOVE usageLimitedUntil");
    expect(sent[0]?.input?.ConditionExpression).toBe(
      "attribute_exists(id) AND updatedAt = :expectedUpdatedAt",
    );

    conditionalFailure = true;
    expect(
      await updateProviderAccount(fakeCtx, {
        id: "acct-1",
        expectedUpdatedAt: "stale",
        updatedAt: "t3",
        patch: { label: "stale" },
      }),
    ).toBe(false);
    expect(
      await clearProviderAccountUsageLimit(fakeCtx, {
        id: "acct-1",
        expectedUpdatedAt: "stale",
        updatedAt: "t3",
      }),
    ).toBe(false);

    conditionalFailure = false;
    expect(
      await clearProviderAccountUsageLimit(fakeCtx, {
        id: "acct-1",
        expectedUpdatedAt: "t2",
        expectedUsageLimitedUntil: null,
        updatedAt: "t4",
      }),
    ).toBe(true);
    expect(sent.at(-1)?.input?.ConditionExpression).toContain(
      "attribute_not_exists(usageLimitedUntil)",
    );

    fakeCtx.doc.send.mockImplementationOnce(async () => {
      throw new Error("storage unavailable");
    });
    await expect(
      updateProviderAccount(fakeCtx, {
        id: "acct-1",
        expectedUpdatedAt: "t4",
        updatedAt: "t5",
        patch: { label: "unavailable" },
      }),
    ).rejects.toThrow("storage unavailable");

    fakeCtx.doc.send.mockImplementationOnce(async () => {
      throw new Error("storage unavailable");
    });
    await expect(
      clearProviderAccountUsageLimit(fakeCtx, {
        id: "acct-1",
        expectedUpdatedAt: "t4",
        expectedUsageLimitedUntil: null,
        updatedAt: "t5",
      }),
    ).rejects.toThrow("storage unavailable");
  });
});
