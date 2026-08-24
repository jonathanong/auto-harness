/* eslint-disable max-lines -- provider account lifecycle and durable conflict cases share fixtures. */

import { describe, expect, it, vi } from "vitest";

import { ControlPlane } from "./control-plane.ts";

describe("ControlPlane provider account CRUD", () => {
  it("validates, creates, lists, updates, and deletes provider accounts", () => {
    let n = 0;
    const plane = new ControlPlane({
      providerAccountIdFactory: () => `acct-${++n}`,
      now: () => "2026-01-01T00:00:00.000Z",
    });
    plane.createProvider({ id: "prov-1", name: "claude" });
    plane.createProvider({ id: "prov-2", name: "codex" });

    expect(plane.createProviderAccount({ providerId: "", label: "" }).ok).toBe(false);
    expect(plane.createProviderAccount({ providerId: "missing", label: "x@y.com" }).ok).toBe(false);
    expect(
      plane.createProviderAccount({
        providerId: "prov-1",
        label: "x@y.com",
        usageLimitCooldownSeconds: 0,
        maxConcurrentSessions: 1,
      }).ok,
    ).toBe(false);

    const acct = plane.createProviderAccount({ providerId: "prov-1", label: "x@y.com" });
    expect(acct.ok).toBe(true);
    if (!acct.ok) {
      throw new Error("unreachable");
    }
    expect(acct.account).toMatchObject({ id: "acct-1", providerId: "prov-1", label: "x@y.com" });

    expect(plane.createProviderAccount({ id: "acct-1", providerId: "prov-1", label: "z" }).ok).toBe(
      false,
    );

    expect(plane.getProviderAccount("acct-1")?.label).toBe("x@y.com");
    expect(plane.getProviderAccount("missing")).toBeNull();
    expect(plane.listProviderAccounts().map((a) => a.label)).toEqual(["x@y.com"]);

    expect(plane.updateProviderAccount("missing", { label: "x" }).ok).toBe(false);
    expect(plane.updateProviderAccount("acct-1", { providerId: "missing" }).ok).toBe(false);
    expect(plane.updateProviderAccount("acct-1", { usageLimitCooldownSeconds: 1.5 }).ok).toBe(
      false,
    );
    const updated = plane.updateProviderAccount("acct-1", {
      providerId: "prov-2",
      label: "y@z.com",
    });
    expect(updated.ok).toBe(true);
    if (updated.ok) {
      expect(updated.account).toMatchObject({ providerId: "prov-2", label: "y@z.com" });
    }

    expect(plane.clearProviderAccountUsageLimit("missing").ok).toBe(false);
    expect(plane.clearProviderAccountUsageLimit("acct-1").ok).toBe(true);
    expect(plane.deleteProviderAccount("missing").ok).toBe(false);
    plane.state.hostInventories.set("host", {
      hostId: "host",
      repositories: [],
      providerAccounts: [{ providerAccountId: "acct-1" }],
      commandProfiles: {},
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(plane.deleteProviderAccount("acct-1").ok).toBe(false);
    plane.state.hostInventories.clear();
    expect(plane.deleteProviderAccount("acct-1").ok).toBe(true);
    expect(plane.getProviderAccount("acct-1")).toBeNull();
  });

  it("queues durable account writes without replacing full records", async () => {
    const storage = {
      putProviderAccount: vi.fn(async () => true),
      updateProviderAccount: vi.fn(async () => true),
      clearProviderAccountUsageLimit: vi.fn(async () => true),
      deleteProviderAccount: vi.fn(async () => true),
    };
    const plane = new ControlPlane({
      storage: storage as never,
      now: () => "2026-01-01T00:00:00.000Z",
    });
    plane.state.providers.set("prov-1", {
      id: "prov-1",
      name: "claude",
      defaultCommandId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(plane.createProviderAccount({ id: "acct-1", providerId: "prov-1", label: "a" }).ok).toBe(
      true,
    );
    expect(
      plane.updateProviderAccount("acct-1", {
        providerId: "prov-1",
        label: "b",
        usageLimitCooldownSeconds: 3600,
        maxConcurrentSessions: 1,
      }).ok,
    ).toBe(true);
    expect(plane.updateProviderAccount("acct-1", { label: "c" }).ok).toBe(true);
    expect(plane.updateProviderAccount("acct-1", { providerId: "prov-1" }).ok).toBe(true);
    expect(plane.clearProviderAccountUsageLimit("acct-1").ok).toBe(true);

    const legacy = plane.createProviderAccount({
      id: "acct-2",
      providerId: "prov-1",
      label: "legacy",
    });
    expect(legacy.ok).toBe(true);
    delete (plane.state.providerAccounts.get("acct-2") as { usageLimitedUntil?: string | null })
      .usageLimitedUntil;
    expect(plane.clearProviderAccountUsageLimit("acct-2").ok).toBe(true);
    expect(plane.deleteProviderAccount("acct-1").ok).toBe(true);
    await plane.settleStorage();
    expect(storage.putProviderAccount).toHaveBeenCalledTimes(2);
    expect(storage.updateProviderAccount).toHaveBeenCalledTimes(3);
    expect(storage.clearProviderAccountUsageLimit).toHaveBeenCalledTimes(2);
    expect(storage.deleteProviderAccount).toHaveBeenCalledWith("acct-1");
  });

  it("lets durable storage decide whether a stale cached lease blocks a cap reduction", async () => {
    const storage = {
      putProviderAccount: vi.fn(async () => true),
      updateProviderAccount: vi.fn(async () => true),
    };
    const plane = new ControlPlane({
      storage: storage as never,
      now: () => "2026-01-01T00:00:00.000Z",
    });
    plane.state.providers.set("prov-1", {
      id: "prov-1",
      name: "claude",
      defaultCommandId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(
      plane.createProviderAccount({
        id: "acct-1",
        providerId: "prov-1",
        label: "account",
        maxConcurrentSessions: 2,
      }).ok,
    ).toBe(true);
    plane.state.providerAccountLeases.set("provider-account:acct-1:1", {
      sessionId: "stale",
      attemptId: "attempt",
      slot: 1,
      hostId: "host",
      providerAccountId: "acct-1",
    });

    expect(plane.updateProviderAccount("acct-1", { maxConcurrentSessions: 1 })).toMatchObject({
      ok: true,
    });
    await plane.settleStorage();
    expect(storage.updateProviderAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedMaxConcurrentSessions: 2,
        patch: { maxConcurrentSessions: 1 },
      }),
    );
  });

  it("uses the default cap when a legacy cached account omits it", () => {
    const plane = new ControlPlane({ now: () => "2026-01-01T00:00:00.000Z" });
    plane.state.providers.set("prov-1", {
      id: "prov-1",
      name: "claude",
      defaultCommandId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(
      plane.createProviderAccount({ id: "acct-1", providerId: "prov-1", label: "account" }).ok,
    ).toBe(true);
    delete (plane.state.providerAccounts.get("acct-1") as { maxConcurrentSessions?: number })
      .maxConcurrentSessions;

    expect(plane.updateProviderAccount("acct-1", { maxConcurrentSessions: 1 })).toMatchObject({
      ok: true,
    });
  });

  it("surfaces a durable cooldown-clear conflict and refreshes the cache", async () => {
    const stale = {
      id: "acct-1",
      providerId: "prov-1",
      label: "account",
      usageLimitCooldownSeconds: 3600,
      maxConcurrentSessions: 1,
      usageLimitedUntil: "2026-01-01T01:00:00.000Z",
      lastUsageLimitedAt: "2026-01-01T00:00:00.000Z",
      lastAssignedAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const authoritative = {
      ...stale,
      usageLimitedUntil: "2026-01-01T02:00:00.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
    };
    const storage = {
      getProviderAccount: vi.fn().mockResolvedValueOnce(stale).mockResolvedValueOnce(authoritative),
      clearProviderAccountUsageLimit: vi.fn(async () => false),
    };
    const plane = new ControlPlane({
      storage: storage as never,
      now: () => "2026-01-01T00:00:02.000Z",
    });
    plane.state.providerAccounts.set(stale.id, stale);

    await expect(plane.clearProviderAccountUsageLimitDurable(stale.id)).resolves.toEqual({
      ok: false,
      conflict: true,
      error: "provider account changed concurrently; retry cooldown clear",
    });
    expect(plane.getProviderAccount(stale.id)).toEqual(authoritative);
  });

  it("handles durable cooldown-clear memory, success, missing, and deletion paths", async () => {
    const account = {
      id: "acct-1",
      providerId: "prov-1",
      label: "account",
      usageLimitCooldownSeconds: 3600,
      maxConcurrentSessions: 1,
      usageLimitedUntil: "2026-01-01T01:00:00.000Z",
      lastUsageLimitedAt: null,
      lastAssignedAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    const memory = new ControlPlane({ now: () => "2026-01-01T00:00:01.000Z" });
    memory.state.providerAccounts.set(account.id, account);
    await expect(memory.clearProviderAccountUsageLimitDurable(account.id)).resolves.toMatchObject({
      ok: true,
      account: { usageLimitedUntil: null },
    });

    const missingStorage = { getProviderAccount: vi.fn(async () => null) };
    const missing = new ControlPlane({ storage: missingStorage as never });
    missing.state.providerAccounts.set(account.id, account);
    await expect(missing.clearProviderAccountUsageLimitDurable(account.id)).resolves.toEqual({
      ok: false,
      error: "provider account not found",
    });
    expect(missing.getProviderAccount(account.id)).toBeNull();

    const legacy = { ...account } as typeof account & { usageLimitedUntil?: string | null };
    delete legacy.usageLimitedUntil;
    const successStorage = {
      getProviderAccount: vi.fn(async () => legacy),
      clearProviderAccountUsageLimit: vi.fn(async () => true),
    };
    const success = new ControlPlane({
      storage: successStorage as never,
      now: () => "2026-01-01T00:00:01.000Z",
    });
    await expect(success.clearProviderAccountUsageLimitDurable(account.id)).resolves.toMatchObject({
      ok: true,
      account: { usageLimitedUntil: null },
    });
    expect(successStorage.clearProviderAccountUsageLimit).toHaveBeenCalledWith(
      expect.not.objectContaining({ expectedUsageLimitedUntil: expect.anything() }),
    );

    const deletedStorage = {
      getProviderAccount: vi.fn().mockResolvedValueOnce(account).mockResolvedValueOnce(null),
      clearProviderAccountUsageLimit: vi.fn(async () => false),
    };
    const deleted = new ControlPlane({ storage: deletedStorage as never });
    deleted.state.providerAccounts.set(account.id, account);
    await expect(deleted.clearProviderAccountUsageLimitDurable(account.id)).resolves.toEqual({
      ok: false,
      error: "provider account not found",
    });
    expect(deleted.getProviderAccount(account.id)).toBeNull();
  });
});
