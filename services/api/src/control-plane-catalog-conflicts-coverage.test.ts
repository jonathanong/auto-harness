import { describe, expect, it } from "vitest";

import type { ProviderAccountRecord } from "./db/plane-storage.ts";
import { addDurableReadDefaults } from "./control-plane-durable-read-test-helpers.ts";
import { ControlPlane } from "./control-plane.ts";

const account = (label = "account"): ProviderAccountRecord => ({
  id: "account",
  providerId: "provider",
  label,
  usageLimitCooldownSeconds: 60,
  usageLimitedUntil: null,
  lastUsageLimitedAt: null,
  lastAssignedAt: null,
  createdAt: "t0",
  updatedAt: "t0",
});

function providerPlane(storage: object): ControlPlane {
  const plane = new ControlPlane({ storage: storage as never, now: () => "t1" });
  plane.state.providers.set("provider", {
    id: "provider",
    name: "provider",
    defaultCommandId: null,
    createdAt: "t0",
    updatedAt: "t0",
  });
  addDurableReadDefaults(plane.state);
  return plane;
}

describe("catalog persistence conflict coverage", () => {
  it("refreshes the authoritative account after a conditional create loss", async () => {
    const winner = account("winner");
    const plane = providerPlane({
      putProviderAccount: async () => false,
      getProviderAccount: async () => winner,
    });

    await expect(
      plane.createProviderAccountDurable({ id: "account", providerId: "provider", label: "loser" }),
    ).resolves.toEqual({ ok: false, error: "provider account already exists" });
    expect(plane.getProviderAccount("account")).toEqual(winner);
  });

  it("does not invent a cache row when a conditional create winner disappears", async () => {
    const plane = providerPlane({
      putProviderAccount: async () => false,
      getProviderAccount: async () => null,
    });

    await expect(
      plane.createProviderAccountDurable({ id: "account", providerId: "provider", label: "loser" }),
    ).resolves.toEqual({ ok: false, error: "provider account already exists" });
    expect(plane.getProviderAccount("account")).toBeNull();
  });

  it("restores the authoritative account after a conditional delete loss", async () => {
    const stale = account("stale");
    const winner = account("winner");
    let reads = 0;
    const plane = providerPlane({
      getProviderAccount: async () => (++reads === 1 ? stale : winner),
      deleteProviderAccount: async () => false,
    });

    await expect(plane.deleteProviderAccountDurable("account")).resolves.toEqual({
      ok: false,
      error: "provider account changed concurrently",
      conflict: true,
    });
    expect(plane.getProviderAccount("account")).toEqual(winner);
  });

  it("reconciles failed queued account updates to an authoritative row or deletion", async () => {
    for (const authoritative of [account("winner"), null]) {
      const plane = providerPlane({
        putProviderAccount: async () => true,
        updateProviderAccount: async () => false,
        getProviderAccount: async () => authoritative,
      });
      plane.state.providerAccounts.set("account", account("stale"));

      expect(plane.updateProviderAccount("account", { label: "optimistic" }).ok).toBe(true);
      await plane.settleStorage();
      expect(plane.getProviderAccount("account")).toEqual(authoritative);
    }
  });

  it("restores a provider after a queued conditional delete loss", async () => {
    const plane = providerPlane({
      deleteProvider: async () => false,
      getProvider: async () => ({
        id: "provider",
        name: "winner",
        defaultCommandId: null,
        createdAt: "t0",
        updatedAt: "t1",
      }),
    });

    expect(plane.deleteProvider("provider")).toEqual({ ok: true });
    await plane.settleStorage();
    expect(plane.getProvider("provider")?.name).toBe("winner");
  });

  it("preserves durable provider and command dependency guards", async () => {
    const accountPlane = providerPlane({ deleteProvider: async () => true });
    accountPlane.state.providerAccounts.set("account", account());
    await expect(accountPlane.deleteProviderDurable("provider")).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("referenced by provider-account account"),
    });

    const commandPlane = providerPlane({ deleteProvider: async () => true });
    commandPlane.state.commands.set("command", {
      id: "command",
      name: "command",
      argv: ["echo"],
      appendPrompt: true,
      providerId: "provider",
      createdAt: "t0",
      updatedAt: "t0",
    });
    await expect(commandPlane.deleteProviderDurable("provider")).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("referenced by command command"),
    });

    commandPlane.state.providers.get("provider")!.defaultCommandId = "command";
    await expect(commandPlane.deleteCommandDurable("command")).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("referenced by provider provider"),
    });
  });

  it("uses an explicit account version in a queued cooldown clear", async () => {
    let expectedVersion: number | undefined;
    const plane = providerPlane({
      clearProviderAccountUsageLimit: async (input: { expectedVersion: number }) => {
        expectedVersion = input.expectedVersion;
        return true;
      },
    });
    plane.state.providerAccounts.set("account", { ...account(), version: 7 });

    expect(plane.clearProviderAccountUsageLimit("account").ok).toBe(true);
    await plane.settleStorage();
    expect(expectedVersion).toBe(7);
  });

  it("rejects an invalid repository rename and accepts an empty patch", () => {
    const plane = new ControlPlane({ now: () => "t1" });
    expect(
      plane.createRepository({ id: "repository", name: "repository", url: "/repository" }).ok,
    ).toBe(true);
    expect(plane.updateRepository("repository", { name: "NOT VALID" })).toMatchObject({
      ok: false,
      error: expect.stringContaining("name must be"),
    });
    expect(plane.updateRepository("repository", {}).ok).toBe(true);
  });
});
