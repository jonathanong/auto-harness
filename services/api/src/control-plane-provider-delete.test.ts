import { describe, expect, it } from "vitest";

import { deleteProvider, deleteProviderDurable } from "./control-plane-provider-delete.ts";
import { createControlPlaneState } from "./control-plane-state.ts";

const provider = {
  id: "provider",
  name: "provider",
  defaultCommandId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("provider deletion", () => {
  it("rejects missing and referenced providers without changing the cache", () => {
    const state = createControlPlaneState();
    expect(deleteProvider(state, "missing")).toEqual({ ok: false, error: "provider not found" });
    state.providers.set(provider.id, provider);
    state.commands.set("command", {
      id: "command",
      name: "command",
      argv: ["echo"],
      appendPrompt: true,
      providerId: provider.id,
      createdAt: provider.createdAt,
      updatedAt: provider.updatedAt,
    });
    expect(deleteProvider(state, provider.id)).toMatchObject({ ok: false, conflict: true });
    expect(state.providers.get(provider.id)).toEqual(provider);
  });

  it("restores the authoritative provider when an asynchronous cache delete loses a race", async () => {
    const state = createControlPlaneState();
    state.providers.set(provider.id, provider);
    state.storage = {
      deleteProvider: async () => false,
      getProvider: async () => provider,
    } as never;
    expect(deleteProvider(state, provider.id)).toEqual({ ok: true });
    await Promise.all(state.pendingPersists);
    expect(state.providers.get(provider.id)).toEqual(provider);
  });

  it("guards a durable delete with its owned marker and drops the cache only after storage wins", async () => {
    const state = createControlPlaneState({ now: () => provider.updatedAt });
    state.providers.set(provider.id, provider);
    const acquired: string[] = [];
    const deleted: unknown[] = [];
    const released: string[] = [];
    state.storage = {
      getProvider: async () => provider,
      listProviderAccounts: async () => [],
      listCommands: async () => [],
      listSchedules: async () => [],
      listAllSessions: async () => [],
      listAllWorktrees: async () => [],
      listHostInventories: async () => [],
      listProviders: async () => [provider],
      acquireDeletionMarker: async (key: string) => {
        acquired.push(key);
        return true;
      },
      releaseDeletionMarker: async (key: string) => {
        released.push(key);
      },
      deleteProvider: async (_id: string, markers: unknown) => {
        deleted.push(markers);
        return true;
      },
    } as never;
    await expect(deleteProviderDurable(state, provider.id)).resolves.toEqual({ ok: true });
    expect(acquired).toEqual(["provider:provider"]);
    expect(deleted).toEqual([
      [{ key: "provider:provider", owner: expect.any(String), now: provider.updatedAt }],
    ]);
    expect(released).toEqual(["provider:provider"]);
    expect(state.providers.has(provider.id)).toBe(false);
  });

  it("keeps the authoritative provider when a guarded durable delete loses its storage race", async () => {
    const state = createControlPlaneState({ now: () => provider.updatedAt });
    state.providers.set(provider.id, provider);
    state.storage = {
      getProvider: async () => provider,
      listProviderAccounts: async () => [],
      listCommands: async () => [],
      listSchedules: async () => [],
      listAllSessions: async () => [],
      listAllWorktrees: async () => [],
      listHostInventories: async () => [],
      listProviders: async () => [provider],
      acquireDeletionMarker: async () => true,
      releaseDeletionMarker: async () => {},
      deleteProvider: async () => false,
    } as never;
    await expect(deleteProviderDurable(state, provider.id)).resolves.toEqual({
      ok: false,
      conflict: true,
      error: "provider changed concurrently",
    });
    expect(state.providers.get(provider.id)).toEqual(provider);
  });

  it("does not write when a provider deletion marker is held by another operation", async () => {
    const state = createControlPlaneState();
    state.providers.set(provider.id, provider);
    state.storage = {
      getProvider: async () => provider,
      listProviderAccounts: async () => [],
      listCommands: async () => [],
      acquireDeletionMarker: async () => false,
      releaseDeletionMarker: async () => {},
    } as never;
    await expect(deleteProviderDurable(state, provider.id)).resolves.toMatchObject({
      ok: false,
      conflict: true,
    });
    expect(state.providers.get(provider.id)).toEqual(provider);
  });

  it("does not recreate a provider that disappeared before a durable delete began", async () => {
    const state = createControlPlaneState();
    state.providers.set(provider.id, provider);
    state.storage = {
      getProvider: async () => null,
      listProviderAccounts: async () => [],
      listCommands: async () => [],
    } as never;
    await expect(deleteProviderDurable(state, provider.id)).resolves.toEqual({
      ok: false,
      error: "provider not found",
    });
    expect(state.providers.has(provider.id)).toBe(false);
  });
});
