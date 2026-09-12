import { describe, expect, it, vi } from "vitest";

import { ControlPlane } from "./control-plane.ts";

describe("durable workspace-pool registration fence", () => {
  it("rejects an advertised pool missing from the durable catalog before leasing", async () => {
    const tryRegisterHost = vi.fn(async () => true);
    const plane = new ControlPlane();
    plane.state.storage = {
      getWorkspacePool: async () => null,
      tryRegisterHost,
    } as never;

    await expect(
      plane.registerHostDurable({
        hostId: "h",
        worktrees: [],
        workspacePools: [{ workspacePoolId: "deleted-pool", slots: [] }],
      }),
    ).resolves.toEqual({ ok: false, error: "unknown workspacePoolId: deleted-pool" });
    expect(tryRegisterHost).not.toHaveBeenCalled();
  });

  it("passes advertised pools as deletion-fenced inventory references", async () => {
    let markers: unknown;
    const plane = new ControlPlane({ connectionIdFactory: () => "c" });
    plane.state.storage = {
      getWorkspacePool: async () => ({ id: "pool", name: "pool", setupProfiles: [] }),
      tryRegisterHost: async () => true,
      getHostInventory: async () => null,
      listWorktreesByHost: async () => [],
      listActiveSessionsByHost: async () => [],
      putHostInventoryFenced: async (
        _inventory: unknown,
        _fence: unknown,
        _expectedVersion: unknown,
        nextMarkers: unknown,
      ) => {
        markers = nextMarkers;
        return { ok: true as const };
      },
    } as never;

    await expect(
      plane.registerHostDurable({
        hostId: "h",
        worktrees: [],
        workspacePools: [{ workspacePoolId: "pool", slots: [] }],
      }),
    ).resolves.toEqual({ ok: true, connectionId: "c" });
    expect(markers).toEqual([{ key: "workspace-pool:pool", now: expect.any(String) }]);
  });

  it("rolls back when a pool deletion marker wins the inventory transaction", async () => {
    const releaseHostConnection = vi.fn(async () => true);
    const plane = new ControlPlane({ connectionIdFactory: () => "c" });
    plane.state.storage = {
      getWorkspacePool: async () => ({ id: "pool", name: "pool", setupProfiles: [] }),
      tryRegisterHost: async () => true,
      getHostInventory: async () => null,
      listWorktreesByHost: async () => [],
      listActiveSessionsByHost: async () => [],
      putHostInventoryFenced: async () => ({ ok: false as const, reason: "reference" as const }),
      releaseHostConnection,
      getHostLock: async () => null,
    } as never;

    await expect(
      plane.registerHostDurable({
        hostId: "h",
        worktrees: [],
        workspacePools: [{ workspacePoolId: "pool", slots: [] }],
      }),
    ).resolves.toEqual({
      ok: false,
      error: "workspace pool changed while publishing inventory",
    });
    expect(releaseHostConnection).toHaveBeenCalledWith("h", "c");
  });

  it("revalidates pool existence after an inventory version retry", async () => {
    let poolReads = 0;
    const releaseHostConnection = vi.fn(async () => true);
    const plane = new ControlPlane({ connectionIdFactory: () => "c" });
    plane.state.storage = {
      getWorkspacePool: async () =>
        poolReads++ === 0 ? { id: "pool", name: "pool", setupProfiles: [] } : null,
      tryRegisterHost: async () => true,
      getHostInventory: async () => null,
      listWorktreesByHost: async () => [],
      listActiveSessionsByHost: async () => [],
      putHostInventoryFenced: async () => ({ ok: false as const, reason: "version" as const }),
      releaseHostConnection,
      getHostLock: async () => null,
    } as never;

    await expect(
      plane.registerHostDurable({
        hostId: "h",
        worktrees: [],
        workspacePools: [{ workspacePoolId: "pool", slots: [] }],
      }),
    ).resolves.toEqual({ ok: false, error: "unknown workspacePoolId: pool" });
    expect(poolReads).toBe(2);
    expect(releaseHostConnection).toHaveBeenCalledOnce();
  });

  it("rejects inventories whose deletion fences would exceed the transaction bound", async () => {
    const putHostInventoryFenced = vi.fn();
    const releaseHostConnection = vi.fn(async () => true);
    const plane = new ControlPlane({ connectionIdFactory: () => "c" });
    plane.state.storage = {
      getWorkspacePool: async (id: string) => ({ id, name: id, setupProfiles: [] }),
      tryRegisterHost: async () => true,
      getHostInventory: async () => null,
      listWorktreesByHost: async () => [],
      listActiveSessionsByHost: async () => [],
      putHostInventoryFenced,
      releaseHostConnection,
      getHostLock: async () => null,
    } as never;

    await expect(
      plane.registerHostDurable({
        hostId: "h",
        worktrees: [],
        workspacePools: Array.from({ length: 99 }, (_, index) => ({
          workspacePoolId: `pool-${index}`,
          slots: [],
        })),
      }),
    ).resolves.toEqual({ ok: false, error: "host inventory has too many catalog references" });
    expect(putHostInventoryFenced).not.toHaveBeenCalled();
    expect(releaseHostConnection).toHaveBeenCalledOnce();
  });
});
