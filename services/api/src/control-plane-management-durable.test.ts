import { describe, expect, it } from "vitest";

import type { ProviderAccountRecord } from "./db/plane-storage.ts";
import { ControlPlane } from "./control-plane.ts";
import { addDurableReadDefaults } from "./control-plane-durable-read-test-helpers.ts";

describe("durable management writes", () => {
  it("preserves the durable management API in memory-only control planes", async () => {
    const plane = new ControlPlane({
      now: () => "2026-01-01T00:00:00.000Z",
      repositoryIdFactory: () => "repository",
      scheduleIdFactory: () => "schedule",
      commandIdFactory: () => "command",
      providerIdFactory: () => "provider",
      providerAccountIdFactory: () => "account",
    });

    expect(
      (await plane.createRepositoryDurable({ name: "repository", url: "https://example.test/r" }))
        .ok,
    ).toBe(true);
    expect((await plane.createCommandDurable({ name: "command", argv: ["echo"] })).ok).toBe(true);
    expect((await plane.createProviderDurable({ name: "provider" })).ok).toBe(true);
    expect(
      (
        await plane.createProviderAccountDurable({
          providerId: "provider",
          label: "account@example.test",
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await plane.putScheduleDurable({
          repositoryId: "repository",
          name: "schedule",
          target: { commandId: "command" },
          cron: "* * * * *",
          timeout: 1,
          nextRunAt: "2026-01-01T00:00:00.000Z",
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await plane.putHostInventoryDurable("host", {
          repositories: [],
          commandProfiles: {},
        })
      ).ok,
    ).toBe(true);

    expect(
      (await plane.updateRepositoryDurable("repository", { name: "repository-next" })).ok,
    ).toBe(true);
    expect((await plane.updateCommandDurable("command", { name: "command-next" })).ok).toBe(true);
    expect((await plane.updateProviderDurable("provider", { name: "provider-next" })).ok).toBe(
      true,
    );
    expect(
      (await plane.updateProviderAccountDurable("account", { label: "account-next@example.test" }))
        .ok,
    ).toBe(true);
    expect((await plane.updateScheduleDurable("schedule", { name: "schedule-next" })).ok).toBe(
      true,
    );
    expect(
      (
        await plane.putHostInventoryDurable("host", {
          repositories: [],
          commandProfiles: {},
          logLevel: "debug",
        })
      ).ok,
    ).toBe(true);

    expect((await plane.deleteScheduleDurable("schedule")).ok).toBe(true);
    expect((await plane.deleteRepositoryDurable("repository")).ok).toBe(true);
    expect((await plane.deleteCommandDurable("command")).ok).toBe(true);
    expect((await plane.deleteProviderAccountDurable("account")).ok).toBe(true);
    expect((await plane.deleteProviderDurable("provider")).ok).toBe(true);
    expect((await plane.deleteHostInventoryDurable("host")).ok).toBe(true);
  });

  it("replaces a stale account cache only with the authoritative compare-and-swap result", async () => {
    let authoritative: ProviderAccountRecord | null = {
      id: "account",
      providerId: "provider",
      label: "authoritative@example.test",
      usageLimitCooldownSeconds: 1,
      usageLimitedUntil: null,
      lastUsageLimitedAt: null,
      lastAssignedAt: null,
      createdAt: "t",
      updatedAt: "t",
    };
    const plane = new ControlPlane({
      storage: {
        updateProviderAccount: async () => false,
        getProviderAccount: async () => authoritative,
      } as never,
    });
    plane.state.providers.set("provider", {
      id: "provider",
      name: "provider",
      defaultCommandId: null,
      createdAt: "t",
      updatedAt: "t",
    });
    plane.state.providerAccounts.set("account", { ...authoritative });
    addDurableReadDefaults(plane.state);

    await expect(
      plane.updateProviderAccountDurable("account", { label: "ignored" }),
    ).resolves.toEqual({
      ok: false,
      error: "provider account changed concurrently; retry update",
      conflict: true,
    });
    expect(plane.getProviderAccount("account")?.label).toBe("authoritative@example.test");

    authoritative = null;
    plane.state.providerAccounts.set("account", {
      id: "account",
      providerId: "provider",
      label: "cached@example.test",
      usageLimitCooldownSeconds: 1,
      usageLimitedUntil: null,
      lastUsageLimitedAt: null,
      lastAssignedAt: null,
      createdAt: "t",
      updatedAt: "t",
    });
    await expect(
      plane.updateProviderAccountDurable("account", { label: "ignored" }),
    ).resolves.toEqual({
      ok: false,
      error: "provider account not found",
    });
    expect(plane.getProviderAccount("account")).toBeNull();
  });

  it("returns pre-write validation failures without mutating a durable cache", async () => {
    const plane = new ControlPlane({ storage: {} as never });
    addDurableReadDefaults(plane.state);

    expect(
      (await plane.createRepositoryDurable({ name: "", url: "https://example.test/r" })).ok,
    ).toBe(false);
    expect((await plane.updateRepositoryDurable("missing", { name: "repository" })).ok).toBe(false);
    expect((await plane.deleteRepositoryDurable("missing")).ok).toBe(false);
    expect(
      (
        await plane.putScheduleDurable({
          repositoryId: "repository",
          name: "schedule",
          target: { commandId: "missing" },
          cron: "* * * * *",
          timeout: 1,
          nextRunAt: "2026-01-01T00:00:00.000Z",
        })
      ).ok,
    ).toBe(false);
    expect((await plane.updateScheduleDurable("missing", { name: "schedule" })).ok).toBe(false);
    expect((await plane.deleteScheduleDurable("missing")).ok).toBe(false);
    expect((await plane.createCommandDurable({ name: "command", argv: [] })).ok).toBe(false);
    expect((await plane.updateCommandDurable("missing", { name: "command" })).ok).toBe(false);
    expect((await plane.deleteCommandDurable("missing")).ok).toBe(false);
    expect((await plane.createProviderDurable({ name: "Provider" })).ok).toBe(false);
    expect((await plane.updateProviderDurable("missing", { name: "provider" })).ok).toBe(false);
    expect((await plane.deleteProviderDurable("missing")).ok).toBe(false);
    expect(
      (
        await plane.createProviderAccountDurable({
          providerId: "missing",
          label: "account@example.test",
        })
      ).ok,
    ).toBe(false);
    expect(
      (await plane.updateProviderAccountDurable("missing", { label: "account@example.test" })).ok,
    ).toBe(false);
    expect((await plane.deleteProviderAccountDurable("missing")).ok).toBe(false);
    expect((await plane.putHostInventoryDurable("host", null)).ok).toBe(false);
    expect((await plane.deleteHostInventoryDurable("host")).ok).toBe(false);
    expect(plane.listRepositories()).toEqual([]);
    expect(plane.listSchedules()).toEqual([]);
    expect(plane.listCommands()).toEqual([]);
    expect(plane.listProviders()).toEqual([]);
    expect(plane.listProviderAccounts()).toEqual([]);
    expect(plane.listHostInventories()).toEqual([]);
  });
});
