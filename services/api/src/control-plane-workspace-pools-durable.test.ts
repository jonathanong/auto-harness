import { expect, it, vi } from "vitest";

import { ControlPlane } from "./control-plane.ts";

it("uses durable workspace-pool catalog reads, writes, and fenced deletion", async () => {
  const record = {
    id: "pool-1",
    name: "durable",
    setupProfiles: [],
    destroyWorkspaceAfter: false,
    createdAt: "now",
    updatedAt: "now",
  };
  const storage = {
    listWorkspacePools: vi.fn(async () => [record]),
    createWorkspacePool: vi.fn(async () => true),
    getWorkspacePool: vi.fn(async () => record),
    putWorkspacePool: vi.fn(async () => undefined),
    acquireDeletionMarker: vi.fn(async () => true),
    renewDeletionMarker: vi.fn(async () => true),
    releaseDeletionMarker: vi.fn(async () => true),
    listSchedules: vi.fn(async () => []),
    listAllSessions: vi.fn(async () => []),
    listSessionDrains: vi.fn(async () => []),
    listAllWorktrees: vi.fn(async () => []),
    listHostInventories: vi.fn(async () => []),
    listProviders: vi.fn(async () => []),
    listProviderAccounts: vi.fn(async () => []),
    listCommands: vi.fn(async () => []),
    deleteWorkspacePool: vi.fn(async () => true),
  };
  const plane = new ControlPlane({ storage: storage as never });
  await expect(plane.listWorkspacePoolsDurable()).resolves.toEqual([record]);
  await expect(plane.getWorkspacePoolDurable("pool-1")).resolves.toEqual(record);
  await expect(
    plane.updateWorkspacePoolDurable("pool-1", { name: "updated" }),
  ).resolves.toMatchObject({
    ok: true,
    workspacePool: { name: "updated" },
  });
  storage.listWorkspacePools.mockResolvedValueOnce([]);
  await expect(plane.createWorkspacePoolDurable({ name: "created" })).resolves.toMatchObject({
    ok: true,
  });
  storage.listWorkspacePools.mockResolvedValueOnce([record]);
  await expect(plane.deleteWorkspacePoolDurable("pool-1")).resolves.toEqual({ ok: true });
  expect(storage.deleteWorkspacePool).toHaveBeenCalledWith("pool-1", [
    expect.objectContaining({ key: "workspace-pool:pool-1" }),
  ]);
});

it("covers durable missing rows, conditional create loss, and storage-backed updates", async () => {
  const record = {
    id: "pool-1",
    name: "durable",
    setupProfiles: [],
    destroyWorkspaceAfter: false,
    createdAt: "now",
    updatedAt: "now",
  };
  const storage = {
    listWorkspacePools: vi.fn(async () => [record]),
    createWorkspacePool: vi.fn(async () => false),
    getWorkspacePool: vi.fn(async () => null),
    putWorkspacePool: vi.fn(async () => undefined),
  };
  const plane = new ControlPlane({ storage: storage as never });

  await expect(plane.createWorkspacePoolDurable({ name: "created" })).resolves.toEqual({
    ok: false,
    error: "workspace pool already exists",
  });
  await expect(plane.getWorkspacePoolDurable("missing")).resolves.toBeNull();
  await expect(plane.updateWorkspacePoolDurable("missing", { name: "missing" })).resolves.toEqual({
    ok: false,
    error: "workspace pool not found",
  });

  storage.listWorkspacePools.mockResolvedValue([record]);
  await expect(plane.updateWorkspacePoolDurable("pool-1", { name: "updated" })).resolves.toEqual({
    ok: true,
    workspacePool: expect.objectContaining({ name: "updated" }),
  });
  expect(storage.putWorkspacePool).toHaveBeenCalledWith(
    expect.objectContaining({ id: "pool-1", name: "updated" }),
  );
});

it("does not update a pool while its deletion marker is held", async () => {
  const record = {
    id: "pool-1",
    name: "durable",
    setupProfiles: [],
    destroyWorkspaceAfter: false,
    createdAt: "now",
    updatedAt: "now",
  };
  const updateWorkspacePool = vi.fn(async () => true);
  const storage = {
    listWorkspacePools: vi.fn(async () => [record]),
    acquireDeletionMarker: vi.fn(async () => false),
    releaseDeletionMarker: vi.fn(async () => undefined),
    updateWorkspacePool,
  };
  const plane = new ControlPlane({ storage: storage as never });
  await expect(plane.updateWorkspacePoolDurable("pool-1", { name: "new-name" })).resolves.toEqual({
    ok: false,
    conflict: true,
    error: "catalog deletion is busy; retry the request",
  });
  expect(updateWorkspacePool).not.toHaveBeenCalled();
});
