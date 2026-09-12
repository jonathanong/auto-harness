/* eslint-disable max-lines -- inventory lifecycle cases share durable/local fixtures. */
import { describe, expect, it, vi } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import {
  syncHostWorkspaceSlots,
  syncHostWorkspaceSlotsDurable,
} from "./control-plane-agent-hosts.ts";
import {
  removeReleasedRetiredWorkspaceSlot,
  removeReleasedRetiredWorkspaceSlotDurable,
} from "./control-plane-workspace-slot-retirement.ts";

describe("agent host inventory", () => {
  it("fences a busy workspace slot from a UNC path alias", () => {
    const plane = new ControlPlane();
    expect(plane.createWorkspacePool({ id: "pool", name: "pool" }).ok).toBe(true);
    plane.state.workspaceSlots.set("leased", {
      id: "leased",
      name: "leased",
      hostId: "host",
      workspacePoolId: "pool",
      path: "\\\\server\\share\\slot",
      status: "busy",
      online: true,
      currentSessionId: "session",
    });

    expect(
      plane.putHostInventory("host", {
        repositories: [],
        workspacePools: [
          {
            workspacePoolId: "pool",
            slots: [{ id: "replacement", name: "replacement", path: "\\\\server\\share\\slot\\." }],
          },
        ],
      }),
    ).toMatchObject({ ok: false, error: expect.stringContaining("replace the id") });
  });

  it("projects local workspace slots and queues storage updates", async () => {
    const plane = new ControlPlane();
    const writes: string[] = [];
    plane.state.hostConnection.set("host", "connection");
    plane.state.workspaceSlots.set("old", {
      id: "old",
      name: "old",
      hostId: "host",
      workspacePoolId: "pool",
      path: "/work/old",
      status: "idle",
      online: true,
      currentSessionId: null,
    });
    plane.state.workspaceSlots.set("busy", {
      id: "busy",
      name: "busy",
      hostId: "host",
      workspacePoolId: "pool",
      path: "/work/busy",
      status: "busy",
      online: true,
      currentSessionId: "session",
    });
    plane.state.storage = {
      putWorkspaceSlot: async (slot: { id: string }) => writes.push(`put:${slot.id}`),
      deleteWorkspaceSlot: async (id: string) => writes.push(`delete:${id}`),
    } as never;
    syncHostWorkspaceSlots(plane.state, {
      hostId: "host",
      version: 1,
      updatedAt: "now",
      repositories: [],
      providerAccounts: [],
      workspacePools: [
        {
          workspacePoolId: "pool",
          slots: [{ id: "fresh", name: "fresh", path: "/work/fresh" }],
        },
      ],
    });
    await plane.state.writeTail;
    expect(writes).toEqual(["put:fresh", "put:busy", "delete:old"]);
    expect(plane.state.workspaceSlots.get("fresh")).toMatchObject({
      online: true,
      connectionId: "connection",
    });
    expect(plane.state.workspaceSlots.has("old")).toBe(false);
    expect(plane.state.workspaceSlots.get("busy")).toMatchObject({ currentSessionId: "session" });
  });

  it("handles durable slot fences, retired races, and released tombstones", async () => {
    const plane = new ControlPlane();
    plane.state.hostConnection.set("host", "connection");
    plane.state.workspaceSlots.set("configured", {
      id: "configured",
      name: "configured",
      hostId: "host",
      workspacePoolId: "pool",
      path: "/work/configured",
      status: "idle",
      online: false,
      currentSessionId: null,
      connectionId: "old",
    });
    plane.state.workspaceSlots.set("busy", {
      id: "busy",
      name: "busy",
      hostId: "host",
      workspacePoolId: "pool",
      path: "/work/busy",
      status: "busy",
      online: true,
      currentSessionId: "session",
    });
    plane.state.workspaceSlots.set("removed", {
      id: "removed",
      name: "removed",
      hostId: "host",
      workspacePoolId: "pool",
      path: "/work/removed",
      status: "idle",
      online: false,
      currentSessionId: null,
    });
    const fenced = vi.fn(async () => true);
    const deleted = vi.fn(async () => true);
    plane.state.storage = {
      putWorkspaceSlot: vi.fn(async () => undefined),
      putWorkspaceSlotFenced: fenced,
      deleteWorkspaceSlotIfIdle: deleted,
    } as never;
    await syncHostWorkspaceSlotsDurable(plane.state, {
      hostId: "host",
      version: 1,
      updatedAt: "now",
      repositories: [],
      providerAccounts: [],
      workspacePools: [
        {
          workspacePoolId: "pool",
          slots: [{ id: "configured", name: "configured", path: "/work/configured" }],
        },
      ],
    });
    expect(fenced).toHaveBeenCalledWith(
      expect.objectContaining({ id: "configured", connectionId: "connection" }),
      "connection",
      "old",
    );
    expect(deleted).toHaveBeenCalledWith("removed");
    expect(plane.state.workspaceSlots.has("removed")).toBe(false);

    const noFence = new ControlPlane();
    noFence.state.workspaceSlots.set("retired", {
      id: "retired",
      name: "retired",
      hostId: "host",
      workspacePoolId: "pool",
      path: "/work/retired",
      status: "busy",
      online: true,
      currentSessionId: "session",
    });
    noFence.state.storage = {
      putWorkspaceSlot: vi.fn(async () => undefined),
      retireWorkspaceSlot: vi.fn(async () => false),
      getWorkspaceSlot: vi.fn(async () => null),
    } as never;
    await syncHostWorkspaceSlotsDurable(noFence.state, {
      hostId: "host",
      version: 1,
      updatedAt: "now",
      repositories: [],
      providerAccounts: [],
      workspacePools: [],
    });
    expect(noFence.state.workspaceSlots.has("retired")).toBe(false);

    const racing = new ControlPlane();
    racing.state.workspaceSlots.set("retired", {
      id: "retired",
      name: "retired",
      hostId: "host",
      workspacePoolId: "pool",
      path: "/work/retired",
      status: "busy",
      online: true,
      currentSessionId: "session",
    });
    let retireAttempts = 0;
    racing.state.storage = {
      putWorkspaceSlot: vi.fn(async () => undefined),
      retireWorkspaceSlot: vi.fn(async () => ++retireAttempts > 1),
      getWorkspaceSlot: vi.fn(async () => ({
        id: "retired",
        name: "retired",
        hostId: "host",
        workspacePoolId: "pool",
        path: "/work/retired",
        status: "busy",
        online: true,
        currentSessionId: "session",
      })),
    } as never;
    await syncHostWorkspaceSlotsDurable(racing.state, {
      hostId: "host",
      version: 1,
      updatedAt: "now",
      repositories: [],
      providerAccounts: [],
      workspacePools: [],
    });
    expect(racing.state.workspaceSlots.get("retired")).toMatchObject({
      retired: true,
      online: false,
    });

    const repeatedlyRacing = new ControlPlane();
    repeatedlyRacing.state.workspaceSlots.set("retired", {
      id: "retired",
      name: "retired",
      hostId: "host",
      workspacePoolId: "pool",
      path: "/work/retired",
      status: "busy",
      online: true,
      currentSessionId: "session",
    });
    repeatedlyRacing.state.storage = {
      putWorkspaceSlot: vi.fn(async () => undefined),
      retireWorkspaceSlot: vi.fn(async () => false),
      getWorkspaceSlot: vi.fn(async () => ({
        id: "retired",
        name: "retired",
        hostId: "host",
        workspacePoolId: "pool",
        path: "/work/retired",
        status: "busy",
        online: true,
        currentSessionId: "session",
      })),
    } as never;
    await expect(
      syncHostWorkspaceSlotsDurable(repeatedlyRacing.state, {
        hostId: "host",
        version: 1,
        updatedAt: "now",
        repositories: [],
        providerAccounts: [],
        workspacePools: [],
      }),
    ).rejects.toThrow("workspace slot changed repeatedly");

    const losingFence = new ControlPlane();
    losingFence.state.hostConnection.set("host", "connection");
    losingFence.state.storage = {
      putWorkspaceSlot: vi.fn(async () => undefined),
      putWorkspaceSlotFenced: vi.fn(async () => false),
    } as never;
    await expect(
      syncHostWorkspaceSlotsDurable(losingFence.state, {
        hostId: "host",
        version: 1,
        updatedAt: "now",
        repositories: [],
        providerAccounts: [],
        workspacePools: [
          { workspacePoolId: "pool", slots: [{ id: "slot", name: "slot", path: "/work/slot" }] },
        ],
      }),
    ).rejects.toThrow("host connection changed while publishing workspace slots");

    const fallbackWrite = new ControlPlane();
    const putWorkspaceSlot = vi.fn(async () => undefined);
    fallbackWrite.state.storage = { putWorkspaceSlot } as never;
    await syncHostWorkspaceSlotsDurable(fallbackWrite.state, {
      hostId: "host",
      version: 1,
      updatedAt: "now",
      repositories: [],
      providerAccounts: [],
      workspacePools: [
        { workspacePoolId: "pool", slots: [{ id: "slot", name: "slot", path: "/work/slot" }] },
      ],
    });
    expect(putWorkspaceSlot).toHaveBeenCalledWith(expect.objectContaining({ id: "slot" }));

    const slot = {
      id: "tombstone",
      name: "tombstone",
      hostId: "host",
      workspacePoolId: "pool",
      path: "/work/tombstone",
      status: "idle" as const,
      online: false,
      currentSessionId: null,
      retired: true,
    };
    noFence.state.workspaceSlots.set(slot.id, slot);
    noFence.state.storage.deleteRetiredWorkspaceSlotIfIdle = vi.fn(async () => true);
    expect(removeReleasedRetiredWorkspaceSlot(noFence.state, slot.id)).toBe(true);
    expect(noFence.state.workspaceSlots.has(slot.id)).toBe(false);
    await noFence.state.writeTail;

    noFence.state.workspaceSlots.set(slot.id, slot);
    noFence.state.storage.deleteRetiredWorkspaceSlotIfIdle = vi.fn(async () => false);
    await expect(removeReleasedRetiredWorkspaceSlotDurable(noFence.state, slot.id)).resolves.toBe(
      false,
    );
    expect(noFence.state.workspaceSlots.has(slot.id)).toBe(true);
    noFence.state.storage.deleteRetiredWorkspaceSlotIfIdle = vi.fn(async () => true);
    await expect(removeReleasedRetiredWorkspaceSlotDurable(noFence.state, slot.id)).resolves.toBe(
      true,
    );

    const directRetire = new ControlPlane();
    directRetire.state.workspaceSlots.set("retired", {
      id: "retired",
      name: "retired",
      hostId: "host",
      workspacePoolId: "pool",
      path: "/work/retired",
      status: "busy",
      online: true,
      currentSessionId: "session",
    });
    directRetire.state.storage = {
      putWorkspaceSlot: vi.fn(async () => undefined),
      retireWorkspaceSlot: vi.fn(async () => true),
    } as never;
    await syncHostWorkspaceSlotsDurable(directRetire.state, {
      hostId: "host",
      version: 1,
      updatedAt: "now",
      repositories: [],
      providerAccounts: [],
      workspacePools: [],
    });
    expect(directRetire.state.workspaceSlots.get("retired")).toMatchObject({
      retired: true,
      online: false,
    });

    const missingRead = new ControlPlane();
    missingRead.state.workspaceSlots.set("retired", {
      id: "retired",
      name: "retired",
      hostId: "host",
      workspacePoolId: "pool",
      path: "/work/retired",
      status: "busy",
      online: true,
      currentSessionId: "session",
    });
    missingRead.state.storage = {
      putWorkspaceSlot: vi.fn(async () => undefined),
      retireWorkspaceSlot: vi.fn(async () => false),
    } as never;
    await syncHostWorkspaceSlotsDurable(missingRead.state, {
      hostId: "host",
      version: 1,
      updatedAt: "now",
      repositories: [],
      providerAccounts: [],
      workspacePools: [],
    });
    expect(missingRead.state.workspaceSlots.has("retired")).toBe(false);

    const deleteIdle = new ControlPlane();
    deleteIdle.state.workspaceSlots.set("retired", {
      id: "retired",
      name: "retired",
      hostId: "host",
      workspacePoolId: "pool",
      path: "/work/retired",
      status: "busy",
      online: true,
      currentSessionId: "session",
    });
    deleteIdle.state.storage = {
      putWorkspaceSlot: vi.fn(async () => undefined),
      retireWorkspaceSlot: vi.fn(async () => false),
      getWorkspaceSlot: vi.fn(async () => ({
        id: "retired",
        name: "retired",
        hostId: "host",
        workspacePoolId: "pool",
        path: "/work/retired",
        status: "idle",
        online: true,
        currentSessionId: null,
      })),
      deleteWorkspaceSlotIfIdle: vi.fn(async () => true),
    } as never;
    await syncHostWorkspaceSlotsDurable(deleteIdle.state, {
      hostId: "host",
      version: 1,
      updatedAt: "now",
      repositories: [],
      providerAccounts: [],
      workspacePools: [],
    });
    expect(deleteIdle.state.workspaceSlots.has("retired")).toBe(false);

    const noStorage = new ControlPlane();
    await syncHostWorkspaceSlotsDurable(noStorage.state, {
      hostId: "host",
      version: 1,
      updatedAt: "now",
      repositories: [],
      providerAccounts: [],
      workspacePools: [],
    });
  });

  it("retires a slot claimed while a durable inventory projection removes it", async () => {
    const plane = new ControlPlane();
    const idleSlot = {
      id: "racing-slot",
      name: "slot",
      hostId: "host",
      workspacePoolId: "pool",
      path: "/work/slot",
      status: "idle" as const,
      online: true,
      currentSessionId: null,
    };
    const claimedSlot = {
      ...idleSlot,
      status: "busy" as const,
      currentSessionId: "session",
    };
    const deleteIfIdle = vi.fn(async () => false);
    const retire = vi.fn(async () => true);
    plane.state.workspaceSlots.set(idleSlot.id, idleSlot);
    plane.state.storage = {
      deleteWorkspaceSlotIfIdle: deleteIfIdle,
      getWorkspaceSlot: async () => claimedSlot,
      putWorkspaceSlot: async () => undefined,
      retireWorkspaceSlot: retire,
    } as never;

    await syncHostWorkspaceSlotsDurable(plane.state, {
      hostId: "host",
      version: 1,
      updatedAt: "now",
      repositories: [],
      providerAccounts: [],
      workspacePools: [],
    });

    expect(deleteIfIdle).toHaveBeenCalledWith(idleSlot.id);
    expect(retire).toHaveBeenCalledWith(idleSlot.id, claimedSlot.currentSessionId);
    expect(plane.state.workspaceSlots.get(idleSlot.id)).toMatchObject({
      ...claimedSlot,
      online: false,
      retired: true,
    });
  });

  it("retires a scheduler winner while a durable host update removes its slot", async () => {
    const plane = new ControlPlane();
    const pool = {
      id: "pool",
      name: "pool",
      setupProfiles: [],
      destroyWorkspaceAfter: false,
      createdAt: "now",
      updatedAt: "now",
    };
    const inventory = {
      hostId: "host",
      version: 1,
      updatedAt: "now",
      repositories: [],
      providerAccounts: [],
      workspacePools: [
        { workspacePoolId: pool.id, slots: [{ id: "racing-slot", name: "slot", path: "/work" }] },
      ],
    };
    const idleSlot = {
      id: "racing-slot",
      name: "slot",
      hostId: inventory.hostId,
      workspacePoolId: pool.id,
      path: "/work",
      status: "idle" as const,
      online: true,
      currentSessionId: null,
    };
    const claimedSlot = {
      ...idleSlot,
      status: "busy" as const,
      currentSessionId: "session",
    };
    const deleteIfIdle = vi.fn(async () => false);
    const retire = vi.fn(async () => true);
    plane.state.storage = {
      getHostInventory: async () => inventory,
      listHostInventories: async () => [inventory],
      listAllWorktrees: async () => [],
      listWorkspaceSlots: async () => [idleSlot],
      listWorkspaceSlotsByPool: async () => [idleSlot],
      listProviderAccounts: async () => [],
      listWorkspacePools: async () => [pool],
      putHostInventory: async () => true,
      deleteWorkspaceSlotIfIdle: deleteIfIdle,
      getWorkspaceSlot: async () => claimedSlot,
      putWorkspaceSlot: async () => undefined,
      retireWorkspaceSlot: retire,
    } as never;

    await expect(
      plane.putHostInventoryDurable(inventory.hostId, { repositories: [] }),
    ).resolves.toMatchObject({
      ok: true,
    });

    expect(deleteIfIdle).toHaveBeenCalledWith(idleSlot.id);
    expect(retire).toHaveBeenCalledWith(idleSlot.id, claimedSlot.currentSessionId);
    expect(plane.state.workspaceSlots.get(idleSlot.id)).toMatchObject({
      ...claimedSlot,
      online: false,
      retired: true,
    });
  });

  it("persists durable inventory projections with fenced and queued slot writes", async () => {
    const pool = {
      id: "pool",
      name: "pool",
      setupProfiles: [],
      destroyWorkspaceAfter: false,
      createdAt: "now",
      updatedAt: "now",
    };
    const host = "durable-projection";
    const slot = { id: "slot", name: "slot", path: "/work/slot" };
    const putInventory = vi.fn(async () => true);
    const putFenced = vi.fn(async () => true);
    const putSlot = vi.fn(async () => undefined);
    const deleteSlot = vi.fn(async () => undefined);
    const storage = {
      listHostInventories: vi.fn(async () => []),
      listAllWorktrees: vi.fn(async () => []),
      listWorkspaceSlots: vi.fn(async () => [
        {
          ...slot,
          hostId: host,
          workspacePoolId: pool.id,
          status: "idle" as const,
          online: false,
          currentSessionId: null,
          connectionId: "connection",
        },
      ]),
      listProviderAccounts: vi.fn(async () => []),
      listWorkspacePools: vi.fn(async () => [pool]),
      putHostInventory: putInventory,
      putWorkspaceSlotFenced: putFenced,
      putWorkspaceSlot: putSlot,
      deleteWorkspaceSlot: deleteSlot,
    };
    const plane = new ControlPlane({ storage: storage as never });
    plane.state.hostConnection.set(host, "connection");
    await expect(
      plane.putHostInventoryDurable(host, {
        repositories: [],
        allowedRoots: ["/work"],
        workspacePools: [{ workspacePoolId: pool.id, slots: [slot] }],
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(putInventory).toHaveBeenCalledWith(
      expect.objectContaining({ hostId: host, version: 1 }),
      expect.any(Array),
      0,
    );
    expect(putFenced).not.toHaveBeenCalled();
    expect(putSlot).toHaveBeenCalledWith(expect.objectContaining({ id: slot.id, online: false }));

    // The committed inventory response can intentionally queue derived projection work.
    plane.state.hostConnection.delete(host);
    await expect(
      plane.putHostInventoryDurable(
        host,
        { repositories: [], allowedRoots: ["/work"] },
        { awaitProjection: false },
      ),
    ).resolves.toMatchObject({ ok: true });
    await plane.state.writeTail;
    expect(deleteSlot).toHaveBeenCalledWith(slot.id);
    expect(putSlot).toHaveBeenCalledTimes(1);
  });

  it("covers durable fenced slot writes, retired projections, and path fallbacks", async () => {
    const noPools = new ControlPlane();
    syncHostWorkspaceSlots(noPools.state, {
      hostId: "no-pools",
      version: 1,
      updatedAt: "now",
      repositories: [],
      providerAccounts: [],
    });
    syncHostWorkspaceSlots(
      noPools.state,
      {
        hostId: "no-pools",
        version: 1,
        updatedAt: "now",
        repositories: [],
        providerAccounts: [],
        workspacePools: [],
      },
      null,
    );
    await syncHostWorkspaceSlotsDurable(noPools.state, {
      hostId: "no-pools",
      version: 1,
      updatedAt: "now",
      repositories: [],
      providerAccounts: [],
    });
    await syncHostWorkspaceSlotsDurable(
      noPools.state,
      {
        hostId: "no-pools",
        version: 1,
        updatedAt: "now",
        repositories: [],
        providerAccounts: [],
      },
      null,
    );
    const durableNull = new ControlPlane();
    durableNull.state.storage = { putWorkspaceSlot: vi.fn(async () => undefined) } as never;
    await syncHostWorkspaceSlotsDurable(
      durableNull.state,
      {
        hostId: "durable-null",
        version: 1,
        updatedAt: "now",
        repositories: [],
        providerAccounts: [],
      },
      null,
    );

    const localRetired = new ControlPlane();
    localRetired.state.workspaceSlots.set("retired", {
      id: "retired",
      name: "retired",
      hostId: "local-retired",
      workspacePoolId: "pool",
      path: "/retired",
      status: "busy",
      online: true,
      currentSessionId: "session",
    });
    localRetired.state.storage = {
      retireWorkspaceSlot: vi.fn(async () => false),
      getWorkspaceSlot: vi.fn(async () => null),
    } as never;
    syncHostWorkspaceSlots(localRetired.state, {
      hostId: "local-retired",
      version: 1,
      updatedAt: "now",
      repositories: [],
      providerAccounts: [],
      workspacePools: [],
    });
    await localRetired.state.writeTail;
    expect(localRetired.state.workspaceSlots.has("retired")).toBe(false);

    const aliasPlane = new ControlPlane();
    expect(aliasPlane.createWorkspacePool({ id: "pool", name: "pool" }).ok).toBe(true);
    aliasPlane.state.workspaceSlots.set("existing", {
      id: "existing",
      name: "existing",
      hostId: "alias-host",
      workspacePoolId: "pool",
      path: "/",
      status: "idle",
      online: false,
      currentSessionId: null,
    });
    expect(
      aliasPlane.putHostInventory("alias-host", {
        repositories: [],
        workspacePools: [
          {
            workspacePoolId: "pool",
            slots: [{ id: "replacement", name: "replacement", path: "/" }],
          },
        ],
      }),
    ).toMatchObject({ ok: true });

    const pool = {
      id: "pool",
      name: "pool",
      setupProfiles: [],
      destroyWorkspaceAfter: false,
      createdAt: "now",
      updatedAt: "now",
    };
    const slot = {
      id: "fenced",
      name: "fenced",
      path: "/work/fenced",
      hostId: "fenced-host",
      workspacePoolId: pool.id,
      status: "idle" as const,
      online: false,
      currentSessionId: null,
      connectionId: "connection",
    };
    const putFenced = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const fencedPlane = new ControlPlane();
    fencedPlane.state.hostConnection.set(slot.hostId, slot.connectionId);
    fencedPlane.state.storage = {
      listHostInventories: vi.fn(async () => []),
      listAllWorktrees: vi.fn(async () => []),
      listWorkspaceSlots: vi.fn(async () => [slot]),
      listWorkspaceSlotsByPool: vi.fn(async () => [slot]),
      listProviderAccounts: vi.fn(async () => []),
      listWorkspacePools: vi.fn(async () => [pool]),
      putHostInventory: vi.fn(async () => true),
      putWorkspaceSlotFenced: putFenced,
      putWorkspaceSlot: vi.fn(async () => undefined),
      deleteWorkspaceSlot: vi.fn(async () => undefined),
    } as never;
    await expect(
      fencedPlane.putHostInventoryDurable(slot.hostId, {
        repositories: [],
        workspacePools: [
          { workspacePoolId: pool.id, slots: [{ id: slot.id, name: slot.name, path: slot.path }] },
        ],
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(putFenced).toHaveBeenCalledTimes(1);
    await expect(
      fencedPlane.putHostInventoryDurable(slot.hostId, {
        repositories: [],
        workspacePools: [
          { workspacePoolId: pool.id, slots: [{ id: slot.id, name: slot.name, path: slot.path }] },
        ],
      }),
    ).resolves.toMatchObject({ ok: false, committed: true });
    expect(putFenced).toHaveBeenCalledWith(
      expect.objectContaining({ id: slot.id }),
      "connection",
      "connection",
    );

    const retiredPlane = new ControlPlane();
    const retired = {
      ...slot,
      id: "retired",
      status: "busy" as const,
      currentSessionId: "session",
    };
    const retireWorkspaceSlot = vi.fn(async () => true);
    retiredPlane.state.storage = {
      listHostInventories: vi.fn(async () => []),
      listAllWorktrees: vi.fn(async () => []),
      listWorkspaceSlots: vi.fn(async () => [retired]),
      listWorkspaceSlotsByPool: vi.fn(async () => [retired]),
      listProviderAccounts: vi.fn(async () => []),
      listWorkspacePools: vi.fn(async () => [pool]),
      putHostInventory: vi.fn(async () => true),
      retireWorkspaceSlot,
      putWorkspaceSlot: vi.fn(async () => undefined),
      deleteWorkspaceSlot: vi.fn(async () => undefined),
    } as never;
    await expect(
      retiredPlane.putHostInventoryDurable(retired.hostId, { repositories: [] }),
    ).resolves.toMatchObject({ ok: true });
    expect(retireWorkspaceSlot).toHaveBeenCalledWith("retired", "session");
  });

  it("defaults durable inventory deletion to version zero when no version is stored", async () => {
    const plane = new ControlPlane();
    const deleteHostInventory = vi.fn(async () => true);
    plane.state.storage = {
      getHostInventory: vi.fn(async () => ({
        hostId: "no-version",
        updatedAt: "now",
        repositories: [],
        providerAccounts: [],
      })),
      listAllWorktrees: vi.fn(async () => []),
      deleteHostInventory,
      deleteWorkspaceSlot: vi.fn(async () => undefined),
      deleteWorktree: vi.fn(async () => undefined),
    } as never;
    await expect(plane.deleteHostInventoryDurable("no-version")).resolves.toMatchObject({
      ok: true,
    });
    expect(deleteHostInventory).toHaveBeenCalledWith("no-version", 0);
  });

  it("fences durable deletion and removes projected worktrees", async () => {
    const plane = new ControlPlane();
    const inventory = {
      hostId: "durable-delete",
      version: 3,
      updatedAt: "t",
      repositories: [],
      providerAccounts: [],
    };
    plane.state.storage = {
      getHostInventory: async (hostId: string) => (hostId === inventory.hostId ? inventory : null),
      listAllWorktrees: async () => [],
      deleteHostInventory: async () => false,
    } as never;
    await expect(plane.deleteHostInventoryDurable(inventory.hostId, 2)).resolves.toMatchObject({
      ok: false,
      conflict: true,
    });
    plane.state.storage.deleteHostInventory = async () => true;
    await expect(plane.deleteHostInventoryDurable(inventory.hostId, 3)).resolves.toEqual({
      ok: true,
    });
    expect(plane.getHostInventory(inventory.hostId)).toBeNull();
  });

  it("cleans up matching local and durable projections and uses legacy slot deletion", async () => {
    const local = new ControlPlane();
    const inventory = {
      hostId: "local-cleanup",
      version: 1,
      updatedAt: "t",
      repositories: [],
      providerAccounts: [],
    };
    local.state.hostInventories.set(inventory.hostId, inventory);
    local.state.worktrees.set("wt", {
      id: "wt",
      name: "wt",
      hostId: inventory.hostId,
      repositoryId: "repo",
      path: "/repo/wt",
      labels: [],
      status: "idle",
      online: false,
    });
    local.state.workspaceSlots.set("slot", {
      id: "slot",
      name: "slot",
      hostId: inventory.hostId,
      workspacePoolId: "pool",
      path: "/pool/slot",
      status: "idle",
      online: false,
      currentSessionId: null,
    });
    local.state.workspaceSlots.set("foreign-slot", {
      id: "foreign-slot",
      name: "foreign-slot",
      hostId: "other-host",
      workspacePoolId: "pool",
      path: "/pool/foreign-slot",
      status: "idle",
      online: false,
      currentSessionId: null,
    });
    expect(local.deleteHostInventory(inventory.hostId)).toEqual({ ok: true });
    expect(local.state.worktrees.has("wt")).toBe(false);
    expect(local.state.workspaceSlots.has("slot")).toBe(false);

    const durable = new ControlPlane();
    const worktree = {
      id: "durable-wt",
      name: "durable-wt",
      hostId: "durable-cleanup",
      repositoryId: "repo",
      path: "/repo/wt",
      labels: [],
      status: "idle" as const,
      online: false,
    };
    const slot = {
      id: "durable-slot",
      name: "durable-slot",
      hostId: "durable-cleanup",
      workspacePoolId: "pool",
      path: "/pool/slot",
      status: "idle" as const,
      online: false,
      currentSessionId: null,
    };
    const keepSlot = { ...slot, id: "keep-slot" };
    const foreignSlot = { ...slot, id: "foreign-slot", hostId: "other-host" };
    const foreignWorktree = { ...worktree, id: "foreign-wt", hostId: "other-host" };
    const deleteSlot = vi.fn(async (id: string) => id !== keepSlot.id);
    durable.state.storage = {
      getHostInventory: async () => ({
        hostId: "durable-cleanup",
        version: 1,
        updatedAt: "t",
        repositories: [],
        providerAccounts: [],
      }),
      listAllWorktrees: async () => [worktree, foreignWorktree],
      listWorkspaceSlots: async () => [slot, keepSlot, foreignSlot],
      listWorkspaceSlotsByPool: async () => [slot, keepSlot, foreignSlot],
      deleteHostInventory: async () => true,
      deleteWorkspaceSlot: async () => undefined,
      getWorkspaceSlot: async (id: string) => (id === keepSlot.id ? keepSlot : null),
      deleteWorkspaceSlotIfIdle: deleteSlot,
      deleteWorktree: async () => undefined,
    } as never;
    await expect(durable.deleteHostInventoryDurable("durable-cleanup")).resolves.toEqual({
      ok: true,
    });
    expect(deleteSlot).toHaveBeenCalledWith(slot.id);
    expect(durable.state.worktrees.has(worktree.id)).toBe(false);
    expect(durable.state.workspaceSlots.has(slot.id)).toBe(false);
    expect(durable.state.workspaceSlots.get(keepSlot.id)).toMatchObject({ online: false });
    expect(durable.state.workspaceSlots.has(foreignSlot.id)).toBe(true);

    const missingLatest = new ControlPlane();
    missingLatest.state.storage = {
      getHostInventory: async () => ({
        hostId: "missing-latest",
        version: 1,
        updatedAt: "t",
        repositories: [],
        providerAccounts: [],
      }),
      listAllWorktrees: async () => [],
      listWorkspaceSlots: async () => [
        { ...slot, hostId: "missing-latest", id: "missing-latest-slot" },
      ],
      listWorkspaceSlotsByPool: async () => [],
      deleteHostInventory: async () => true,
      deleteWorkspaceSlotIfIdle: async () => false,
      deleteWorktree: async () => undefined,
      getWorkspaceSlot: async () => null,
    } as never;
    await expect(missingLatest.deleteHostInventoryDurable("missing-latest")).resolves.toEqual({
      ok: true,
    });

    const noLatestReader = new ControlPlane();
    noLatestReader.state.storage = {
      getHostInventory: async () => ({
        hostId: "no-latest-reader",
        version: 1,
        updatedAt: "t",
        repositories: [],
        providerAccounts: [],
      }),
      listAllWorktrees: async () => [],
      listWorkspaceSlots: async () => [
        { ...slot, hostId: "no-latest-reader", id: "no-latest-reader-slot" },
      ],
      listWorkspaceSlotsByPool: async () => [],
      deleteHostInventory: async () => true,
      deleteWorkspaceSlotIfIdle: async () => false,
      deleteWorktree: async () => undefined,
    } as never;
    await expect(noLatestReader.deleteHostInventoryDurable("no-latest-reader")).resolves.toEqual({
      ok: true,
    });
  });

  it("falls back to an unfenced slot write when no live connection is known", async () => {
    const putWorkspaceSlot = vi.fn(async () => undefined);
    const plane = new ControlPlane();
    plane.state.storage = {
      listHostInventories: async () => [],
      listAllWorktrees: async () => [],
      listWorkspaceSlots: async () => [],
      listWorkspaceSlotsByPool: async () => [],
      listProviderAccounts: async () => [],
      listWorkspacePools: async () => [
        {
          id: "pool",
          name: "pool",
          setupProfiles: [],
          destroyWorkspaceAfter: false,
          createdAt: "t",
          updatedAt: "t",
        },
      ],
      putHostInventory: async () => true,
      putWorkspaceSlot,
      deleteWorkspaceSlot: async () => undefined,
    } as never;
    await expect(
      plane.putHostInventoryDurable("unconnected", {
        repositories: [],
        workspacePools: [
          { workspacePoolId: "pool", slots: [{ id: "slot", name: "slot", path: "/slot" }] },
        ],
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(putWorkspaceSlot).toHaveBeenCalledWith(expect.objectContaining({ id: "slot" }));
  });

  it("handles a changing retired-slot API while retrying the durable fence", async () => {
    const plane = new ControlPlane();
    plane.state.workspaceSlots.set("retired", {
      id: "retired",
      name: "retired",
      hostId: "changing-retire",
      workspacePoolId: "pool",
      path: "/pool/retired",
      status: "busy",
      online: true,
      currentSessionId: "session",
    });
    let reads = 0;
    const storage: Record<string, unknown> = {
      putWorkspaceSlot: vi.fn(async () => undefined),
      retireWorkspaceSlot: vi.fn(async () => {
        delete storage.retireWorkspaceSlot;
        return false;
      }),
      getWorkspaceSlot: vi.fn(async () => {
        reads += 1;
        if (reads === 1) delete storage.getWorkspaceSlot;
        return reads === 1
          ? {
              id: "retired",
              name: "retired",
              hostId: "changing-retire",
              workspacePoolId: "pool",
              path: "/pool/retired",
              status: "busy" as const,
              online: true,
              currentSessionId: "replacement",
            }
          : null;
      }),
    };
    plane.state.storage = storage as never;
    await syncHostWorkspaceSlotsDurable(plane.state, {
      hostId: "changing-retire",
      version: 1,
      updatedAt: "now",
      repositories: [],
      providerAccounts: [],
      workspacePools: [],
    });
    expect(plane.state.workspaceSlots.has("retired")).toBe(false);
  });

  it("uses the legacy durable delete operation when idle-delete is unavailable", async () => {
    const plane = new ControlPlane();
    const slot = {
      id: "legacy-slot",
      name: "legacy-slot",
      hostId: "legacy-delete",
      workspacePoolId: "pool",
      path: "/pool/legacy-slot",
      status: "idle" as const,
      online: false,
      currentSessionId: null,
    };
    const deleteWorkspaceSlot = vi.fn(async () => undefined);
    plane.state.storage = {
      getHostInventory: async () => ({
        hostId: "legacy-delete",
        version: 1,
        updatedAt: "t",
        repositories: [],
        providerAccounts: [],
      }),
      listAllWorktrees: async () => [],
      listWorkspaceSlots: async () => [slot],
      listWorkspaceSlotsByPool: async () => [slot],
      deleteHostInventory: async () => true,
      deleteWorkspaceSlot,
      deleteWorktree: async () => undefined,
    } as never;
    await expect(plane.deleteHostInventoryDurable("legacy-delete")).resolves.toEqual({ ok: true });
    expect(deleteWorkspaceSlot).toHaveBeenCalledWith(slot.id);
  });

  it("removes a retired slot when durable inventory projection observes it released", async () => {
    const plane = new ControlPlane();
    const retired = {
      id: "retired-before-put",
      name: "retired",
      hostId: "projection-host",
      workspacePoolId: "pool",
      path: "/pool/retired",
      status: "busy" as const,
      online: false,
      currentSessionId: "session",
      retired: true,
    };
    plane.state.workspaceSlots.set(retired.id, retired);
    plane.state.storage = {
      listHostInventories: async () => [
        {
          hostId: "projection-host",
          version: 1,
          updatedAt: "t",
          repositories: [],
          providerAccounts: [],
        },
      ],
      listAllWorktrees: async () => [],
      putHostInventory: async () => true,
      retireWorkspaceSlot: async () => false,
      getWorkspaceSlot: async () => null,
      putWorkspaceSlot: async () => undefined,
      deleteWorkspaceSlot: async () => undefined,
    } as never;
    await expect(
      plane.putHostInventoryDurable("projection-host", { repositories: [] }),
    ).resolves.toMatchObject({ ok: true });
    expect(plane.state.workspaceSlots.has(retired.id)).toBe(false);
  });

  it("publishes a newly configured durable slot offline without claiming daemon acknowledgement", async () => {
    const plane = new ControlPlane();
    plane.state.hostConnection.set("fenced-host", "connection");
    const putWorkspaceSlot = vi.fn(async () => undefined);
    plane.state.storage = {
      listHostInventories: async () => [],
      listAllWorktrees: async () => [],
      listWorkspaceSlots: async () => [],
      listWorkspaceSlotsByPool: async () => [],
      listProviderAccounts: async () => [],
      listWorkspacePools: async () => [
        {
          id: "pool",
          name: "pool",
          setupProfiles: [],
          destroyWorkspaceAfter: false,
          createdAt: "now",
          updatedAt: "now",
        },
      ],
      putHostInventory: async () => true,
      putWorkspaceSlotFenced: async () => false,
      putWorkspaceSlot,
    } as never;
    await expect(
      plane.putHostInventoryDurable("fenced-host", {
        repositories: [],
        workspacePools: [
          { workspacePoolId: "pool", slots: [{ id: "slot", name: "slot", path: "/slot" }] },
        ],
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(putWorkspaceSlot).toHaveBeenCalledWith(
      expect.objectContaining({ id: "slot", online: false }),
    );
  });

  it("blocks local and durable inventory deletion while a workspace slot is active", async () => {
    const plane = new ControlPlane();
    const inventory = {
      hostId: "busy-host",
      version: 1,
      updatedAt: "t",
      repositories: [],
      providerAccounts: [],
    };
    plane.state.hostInventories.set(inventory.hostId, inventory);
    const busySlot = {
      id: "busy-slot",
      name: "busy",
      hostId: inventory.hostId,
      workspacePoolId: "pool",
      path: "/pool/busy",
      status: "busy",
      online: true,
      currentSessionId: "session",
    } as const;
    plane.state.workspaceSlots.set("busy-slot", busySlot);
    expect(plane.deleteHostInventory(inventory.hostId)).toMatchObject({
      ok: false,
      error: "host has active workspace slots",
    });
    const deleteInventory = vi.fn(async () => true);
    plane.state.storage = {
      getHostInventory: async () => inventory,
      listAllWorktrees: async () => [],
      listWorkspaceSlots: async () => [busySlot],
      listWorkspaceSlotsByPool: async () => [busySlot],
      deleteHostInventory: deleteInventory,
    } as never;
    plane.state.workspaceSlots.clear();
    await expect(plane.deleteHostInventoryDurable(inventory.hostId)).resolves.toMatchObject({
      ok: false,
      error: "host has active workspace slots",
    });
    expect(deleteInventory).not.toHaveBeenCalled();
  });

  it("retains a slot when assignment wins during durable inventory deletion", async () => {
    const plane = new ControlPlane();
    const inventory = {
      hostId: "racing-host",
      version: 1,
      updatedAt: "t",
      repositories: [],
      providerAccounts: [],
    };
    const idleSlot = {
      id: "racing-slot",
      name: "slot",
      hostId: inventory.hostId,
      workspacePoolId: "pool",
      path: "/pool/slot",
      status: "idle" as const,
      online: true,
      currentSessionId: null,
    };
    const assignedSlot = { ...idleSlot, status: "busy" as const, currentSessionId: "session" };
    const deleteSlot = vi.fn(async () => false);
    plane.state.storage = {
      getHostInventory: async () => inventory,
      listAllWorktrees: async () => [],
      listWorkspaceSlots: async () => [idleSlot],
      listWorkspaceSlotsByPool: async () => [idleSlot],
      deleteHostInventory: async () => true,
      deleteWorkspaceSlotIfIdle: deleteSlot,
      getWorkspaceSlot: async () => assignedSlot,
    } as never;
    const result = await plane.deleteHostInventoryDurable(inventory.hostId);
    expect(result.ok).toBe(true);
    expect(deleteSlot).toHaveBeenCalledWith(idleSlot.id);
    expect(plane.state.workspaceSlots.get(idleSlot.id)).toMatchObject({
      ...assignedSlot,
      online: false,
    });
  });

  it("stores config and syncs worktrees", () => {
    const plane = new ControlPlane({ now: () => "2026-01-01T00:00:00.000Z" });
    const put = plane.putHostInventory("local-1", {
      hostId: "local-1",
      setupScript: "source ~/.zshrc",
      repositories: [
        {
          id: "demo",
          path: "/repo",
          defaultBranch: "main",
          setupScript: "true",
          terminalHookScript: "/hook",
          worktrees: [
            { id: "wt-1", name: "wt-1", path: "/repo/wt-1", labels: ["echo"], setupScript: "true" },
            { id: "wt-2", name: "wt-2", path: "/repo/wt-2", labels: [] },
          ],
        },
      ],
    });
    expect(put.ok).toBe(true);
    expect(plane.getHostInventory("local-1")?.setupScript).toBe("source ~/.zshrc");
    expect(plane.getHostInventory("local-1")?.repositories[0]?.path).toBe("/repo");
    expect(plane.listWorktrees().filter((w) => w.hostId === "local-1")).toHaveLength(2);
    expect(plane.listHostInventories()).toHaveLength(1);
    expect(plane.putHostInventory("local-1", { repositories: [], version: 0 })).toMatchObject({
      ok: false,
      conflict: true,
    });

    // Replace inventory: drop wt-2, keep wt-1
    const replace = plane.putHostInventory("local-1", {
      repositories: [
        {
          id: "demo",
          path: "/repo",
          worktrees: [{ id: "wt-1", name: "wt-1", path: "/repo/wt-1", labels: ["echo"] }],
        },
      ],
    });
    expect(replace.ok).toBe(true);
    expect(plane.listWorktrees().map((w) => w.id)).toEqual(["wt-1"]);

    // Empty inventory is valid (add-agent / attach-repos-later).
    const empty = plane.putHostInventory("local-1", { repositories: [] });
    expect(empty.ok).toBe(true);
    if (empty.ok) {
      expect(empty.config.repositories).toEqual([]);
    }
    // Offline host-only agent appears in fleet list.
    expect(plane.putHostInventory("slot-offline", { repositories: [] }).ok).toBe(true);
    const agents = plane.listHosts();
    const offline = agents.find((a) => a.hostId === "slot-offline");
    expect(offline).toMatchObject({
      hostId: "slot-offline",
      online: false,
      connectedAt: null,
      worktreeIds: [],
    });
    // Host for an already-listed agent is skipped in the offline-host merge loop.
    plane.registerHost({ hostId: "slot-offline", worktrees: [] });
    const afterReg = plane.listHosts().find((a) => a.hostId === "slot-offline");
    expect(afterReg?.online).toBe(true);
    expect(afterReg?.connectedAt).toBe("2026-01-01T00:00:00.000Z");
    // Offline host with worktrees exposes worktreeIds in the fleet list.
    expect(
      plane.putHostInventory("host-with-wts", {
        repositories: [
          {
            id: "r1",
            path: "/r",
            worktrees: [
              { id: "w1", name: "w1", path: "/r/w1", labels: [] },
              { id: "w2", name: "w2", path: "/r/w2", labels: ["echo"] },
            ],
          },
        ],
      }).ok,
    ).toBe(true);
    expect(plane.listHosts().find((a) => a.hostId === "host-with-wts")?.worktreeIds).toEqual([
      "w1",
      "w2",
    ]);
    // Still invalid: missing/non-array repositories, or a non-object body.
    expect(plane.putHostInventory("local-1", {}).ok).toBe(false);
    expect(plane.putHostInventory("local-1", { repositories: "x" }).ok).toBe(false);
    expect(plane.putHostInventory("local-1", null).ok).toBe(false);
    expect(plane.putHostInventory("local-1", { repositories: [], setupScript: 1 }).ok).toBe(false);
    expect(
      plane.putHostInventory("local-1", {
        hostId: "other",
        repositories: [
          { id: "d", path: "/r", worktrees: [{ id: "w", name: "w", path: "/w", labels: [] }] },
        ],
      }).ok,
    ).toBe(false);
    expect(
      plane.putHostInventory("x", {
        repositories: [{ id: "d", path: "/r", worktrees: "x" }],
      }).ok,
    ).toBe(false);
    expect(
      plane.putHostInventory("x", {
        repositories: [
          { id: "d", path: "/r", worktrees: [{ id: "w", name: "w", path: "/w", labels: "x" }] },
        ],
      }).ok,
    ).toBe(false);
    expect(
      plane.putHostInventory("x", {
        repositories: [{ id: "d", path: "/r", worktrees: [null] }],
      }).ok,
    ).toBe(false);
    expect(plane.putHostInventory("x", { repositories: [null] }).ok).toBe(false);
    expect(
      plane.putHostInventory("x", {
        repositories: [
          {
            id: "d",
            path: "/r",
            setupScript: 1,
            worktrees: [{ id: "w", name: "w", path: "/w", labels: [] }],
          },
        ],
      }).ok,
    ).toBe(false);
    expect(
      plane.putHostInventory("x", {
        repositories: [
          {
            id: "d",
            path: "/r",
            terminalHookScript: 1,
            worktrees: [{ id: "w", name: "w", path: "/w", labels: [] }],
          },
        ],
      }).ok,
    ).toBe(false);
    expect(
      plane.putHostInventory("x", {
        repositories: [
          {
            id: "d",
            path: "/r",
            worktrees: [{ id: "w", name: "w", path: "/w", labels: [], setupScript: 1 }],
          },
        ],
      }).ok,
    ).toBe(false);

    expect(plane.deleteHostInventory("local-1").ok).toBe(true);
    expect(plane.getHostInventory("local-1")).toBeNull();
    expect(plane.deleteHostInventory("local-1").ok).toBe(false);

    expect(plane.putHostInventory("delete-version", { repositories: [] })).toMatchObject({
      ok: true,
    });
    expect(plane.deleteHostInventory("delete-version", 0)).toMatchObject({
      ok: false,
      conflict: true,
    });

    plane.state.hostInventories.set("unversioned", {
      repositories: [],
      providerAccounts: [],
    } as never);
    expect(plane.deleteHostInventory("unversioned").ok).toBe(true);
  });

  it("ignores a viewer's browser connection when listing hosts", () => {
    const plane = new ControlPlane();
    // A browser viewer WebSocket shares the same connections map, keyed by a
    // "user:<name>"-shaped principal id rather than a real hostId. listHosts
    // must never surface it as an online host.
    plane.state.connections.set("viewer-conn", {
      connectionId: "viewer-conn",
      type: "client",
      hostId: "user:alice",
      connectedAt: "t",
      lastHeartbeatAt: "t",
    });
    expect(plane.listHosts().find((a) => a.hostId === "user:alice")).toBeUndefined();
  });
});
