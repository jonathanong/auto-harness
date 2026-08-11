import { describe, expect, it } from "vitest";

import { ControlPlane } from "../control-plane.ts";
import { createDynamoTestCtx } from "./dynamo-test-helpers.ts";

const ctx = createDynamoTestCtx("StoPr");

const fixedNow = () => "2026-01-01T00:00:00.000Z";

describe("DynamoDB Local provider catalog storage", () => {
  it("does not delete a provider while it owns an account", async () => {
    if (!ctx.available || !ctx.storage) return;
    const storage = ctx.storage;
    await storage.putProvider({
      id: "prov-guard",
      name: "guard",
      defaultCommandId: null,
      createdAt: "t",
      updatedAt: "t",
    });
    expect(
      await storage.putProviderAccount({
        id: "acct-guard",
        providerId: "prov-guard",
        label: "guard@example.com",
        usageLimitCooldownSeconds: 60,
        usageLimitedUntil: null,
        lastUsageLimitedAt: null,
        lastAssignedAt: null,
        createdAt: "t",
        updatedAt: "t",
      }),
    ).toBe(true);
    expect(await storage.deleteProvider("prov-guard")).toBe(false);
    await storage.putProvider({
      id: "prov-next",
      name: "next",
      defaultCommandId: null,
      createdAt: "t",
      updatedAt: "t",
    });
    expect(
      await storage.updateProviderAccount({
        id: "acct-guard",
        expectedVersion: 1,
        expectedProviderId: "prov-guard",
        updatedAt: "t",
        patch: { providerId: "prov-next" },
      }),
    ).toBe(true);
    expect(await storage.deleteProvider("prov-guard")).toBe(true);
    expect(await storage.deleteProvider("prov-next")).toBe(false);
    expect(await storage.deleteProviderAccount("acct-guard")).toBe(true);
    expect(await storage.deleteProvider("prov-next")).toBe(true);
  });

  it("uses a monotonic fence when fixed-clock workers update one account", async () => {
    if (!ctx.available || !ctx.storage) return;
    const storage = ctx.storage;
    await storage.putProvider({
      id: "prov-fence",
      name: "fence",
      defaultCommandId: null,
      createdAt: "t",
      updatedAt: "t",
    });
    await storage.putProviderAccount({
      id: "acct-fence",
      providerId: "prov-fence",
      label: "before",
      usageLimitCooldownSeconds: 60,
      usageLimitedUntil: null,
      lastUsageLimitedAt: null,
      lastAssignedAt: null,
      createdAt: "t",
      updatedAt: "t",
    });
    const [first, second] = [
      new ControlPlane({ storage, now: fixedNow }),
      new ControlPlane({ storage, now: fixedNow }),
    ];
    await Promise.all([first.hydrateFromStorage(), second.hydrateFromStorage()]);
    first.updateProviderAccount("acct-fence", { label: "first" });
    second.updateProviderAccount("acct-fence", { label: "second" });
    await Promise.all([first.settleStorage(), second.settleStorage()]);
    const durable = await storage.getProviderAccount("acct-fence");
    expect(durable).toMatchObject({ version: 2 });
    expect(["first", "second"]).toContain(durable?.label);
    const loser = durable?.label === "first" ? second : first;
    expect(loser.getProviderAccount("acct-fence")).toEqual(durable);
  });

  it("keeps provider references valid while account creation races provider deletion", async () => {
    if (!ctx.available || !ctx.storage) return;
    const storage = ctx.storage;
    await storage.putProvider({
      id: "prov-race",
      name: "race",
      defaultCommandId: null,
      createdAt: "t",
      updatedAt: "t",
    });
    const creator = new ControlPlane({ storage, now: fixedNow });
    const deleter = new ControlPlane({ storage, now: fixedNow });
    await Promise.all([creator.hydrateFromStorage(), deleter.hydrateFromStorage()]);
    expect(
      creator.createProviderAccount({
        id: "acct-race",
        providerId: "prov-race",
        label: "race@example.com",
      }).ok,
    ).toBe(true);
    expect(deleter.deleteProvider("prov-race").ok).toBe(true);
    await Promise.all([creator.settleStorage(), deleter.settleStorage()]);
    const [provider, account] = await Promise.all([
      storage.getProvider("prov-race"),
      storage.getProviderAccount("acct-race"),
    ]);
    expect(Boolean(provider)).toBe(Boolean(account));
    if (account) expect(account.providerId).toBe("prov-race");
  });
});
