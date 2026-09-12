/* eslint-disable max-lines */
import { expect, it, vi } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import {
  getWorkspacePoolPublicDurable,
  listWorkspacePoolSummariesDurable,
  listWorkspacePoolsPublicDurable,
} from "./control-plane-workspace-pools.ts";
import { createControlPlaneState } from "./control-plane-state.ts";

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

it("covers local fallbacks, queued persistence, and durable conditional update outcomes", async () => {
  const local = new ControlPlane({ workspacePoolIdFactory: () => "local" });
  const putWorkspacePool = vi.fn(async () => undefined);
  local.state.storage = { putWorkspacePool } as never;
  expect(local.createWorkspacePool({ name: "local" })).toMatchObject({ ok: true });
  await local.state.writeTail;
  expect(putWorkspacePool).toHaveBeenCalledWith(expect.objectContaining({ id: "local" }));

  const noStorage = new ControlPlane({ workspacePoolIdFactory: () => "fallback" });
  await expect(noStorage.createWorkspacePoolDurable({ name: "fallback" })).resolves.toMatchObject({
    ok: true,
  });
  await expect(noStorage.listWorkspacePoolsDurable()).resolves.toHaveLength(1);
  await expect(noStorage.getWorkspacePoolDurable("fallback")).resolves.toMatchObject({
    id: "fallback",
  });
  expect(noStorage.updateWorkspacePool("fallback", { name: "renamed" })).toMatchObject({
    ok: true,
  });

  const record = {
    id: "pool-1",
    name: "durable",
    setupProfiles: [],
    destroyWorkspaceAfter: false,
    createdAt: "now",
    updatedAt: "now",
  };
  const updateWorkspacePool = vi.fn(async () => false);
  const storage = {
    listWorkspacePools: async () => [record],
    updateWorkspacePool,
    acquireDeletionMarker: async () => true,
    releaseDeletionMarker: async () => true,
    renewDeletionMarker: async () => true,
  };
  const durable = new ControlPlane({ storage: storage as never });
  await expect(
    durable.updateWorkspacePoolDurable(record.id, { name: "new-name" }),
  ).resolves.toEqual({
    ok: false,
    error: "workspace pool not found",
  });
  expect(updateWorkspacePool).toHaveBeenCalledWith(expect.objectContaining({ name: "new-name" }));
});

it("uses script-free pool summaries for public durable listings", async () => {
  const listWorkspacePoolSummaries = vi.fn(async () => [
    {
      id: "pool-1",
      name: "durable",
      setupProfiles: [{ id: "install", name: "Install" }],
      defaultSetupProfileId: "install",
      destroyWorkspaceAfter: false,
      createdAt: "now",
      updatedAt: "now",
    },
  ]);
  const listWorkspacePools = vi.fn(async () => {
    throw new Error("full pool scan must not run for public listing");
  });
  const plane = new ControlPlane({
    storage: { listWorkspacePoolSummaries, listWorkspacePools } as never,
  });

  await expect(plane.listWorkspacePoolsPublicDurable()).resolves.toEqual([
    {
      id: "pool-1",
      name: "durable",
      setupProfiles: [{ id: "install", name: "Install" }],
      defaultSetupProfileId: "install",
      destroyWorkspaceAfter: false,
      createdAt: "now",
      updatedAt: "now",
    },
  ]);
  expect(listWorkspacePoolSummaries).toHaveBeenCalledOnce();
  expect(listWorkspacePools).not.toHaveBeenCalled();
});

it("covers invalid durable pool preparation, tie sorting, and local persistence", async () => {
  const invalid = new ControlPlane({ workspacePoolIdFactory: () => "invalid" });
  const storage = {
    listWorkspacePools: vi.fn(async () => []),
    createWorkspacePool: vi.fn(async () => true),
    putWorkspacePool: vi.fn(async () => undefined),
  };
  invalid.state.storage = storage as never;
  await expect(invalid.createWorkspacePoolDurable({ name: "" })).resolves.toMatchObject({
    ok: false,
  });

  const tied = new ControlPlane({ storage: storage as never });
  tied.state.workspacePools.set("b", {
    id: "b",
    name: "same",
    setupProfiles: [],
    destroyWorkspaceAfter: false,
    createdAt: "now",
    updatedAt: "now",
  });
  tied.state.workspacePools.set("a", {
    id: "a",
    name: "same",
    setupProfiles: [],
    destroyWorkspaceAfter: false,
    createdAt: "now",
    updatedAt: "now",
  });
  expect(tied.listWorkspacePools().map((pool) => pool.id)).toEqual(["a", "b"]);

  const local = new ControlPlane({ workspacePoolIdFactory: () => "local" });
  local.state.storage = storage as never;
  local.state.workspacePools.set("local", {
    id: "local",
    name: "local",
    setupProfiles: [],
    destroyWorkspaceAfter: false,
    createdAt: "now",
    updatedAt: "now",
  });
  expect(local.updateWorkspacePool("local", { name: "renamed" })).toMatchObject({ ok: true });
  await local.state.writeTail;
  storage.listWorkspacePools.mockResolvedValue([
    {
      id: "valid",
      name: "valid",
      setupProfiles: [],
      destroyWorkspaceAfter: false,
      createdAt: "now",
      updatedAt: "now",
    },
  ]);
  await expect(invalid.updateWorkspacePoolDurable("valid", { name: "" })).resolves.toMatchObject({
    ok: false,
  });
});

it("blocks durable deletion when refreshed inventories reference the pool", async () => {
  const record = {
    id: "pool-1",
    name: "durable",
    setupProfiles: [],
    destroyWorkspaceAfter: false,
    createdAt: "now",
    updatedAt: "now",
  };
  const storage = {
    listWorkspacePools: async () => [record],
    acquireDeletionMarker: async () => true,
    releaseDeletionMarker: async () => true,
    listSchedules: async () => [],
    listAllSessions: async () => [],
    listSessionDrains: async () => [],
    listAllWorktrees: async () => [],
    listHostInventories: async () => [
      {
        hostId: "host",
        repositories: [],
        providerAccounts: [],
        workspacePools: [{ workspacePoolId: record.id }],
      },
    ],
    listProviders: async () => [],
    listProviderAccounts: async () => [],
    listCommands: async () => [],
  };
  const plane = new ControlPlane({ storage: storage as never });
  await expect(plane.deleteWorkspacePoolDurable(record.id)).resolves.toMatchObject({
    ok: false,
    error: "workspace pool is attached to a host",
  });
});

it("keeps public pool reads script-free across local and legacy durable fallbacks", async () => {
  const state = createControlPlaneState();
  state.workspacePools.set("pool", {
    id: "pool",
    name: "pool",
    setupProfiles: [{ id: "setup", name: "Setup", script: "secret" }],
    setupProfileSummaries: [{ id: "setup", name: "Setup" }],
    defaultSetupProfileId: "setup",
    destroyWorkspaceAfter: false,
    createdAt: "now",
    updatedAt: "now",
  });

  await expect(getWorkspacePoolPublicDurable(state, "pool")).resolves.toEqual({
    id: "pool",
    name: "pool",
    setupProfiles: [{ id: "setup", name: "Setup" }],
    defaultSetupProfileId: "setup",
    destroyWorkspaceAfter: false,
    createdAt: "now",
    updatedAt: "now",
  });
  await expect(getWorkspacePoolPublicDurable(state, "missing")).resolves.toBeNull();

  const refreshed = vi.fn(async () => {
    state.workspacePools.set("refreshed", {
      id: "refreshed",
      name: "refreshed",
      setupProfiles: [],
      destroyWorkspaceAfter: true,
      createdAt: "now",
      updatedAt: "now",
    });
  });
  await expect(listWorkspacePoolsPublicDurable(state, refreshed)).resolves.toEqual([
    expect.objectContaining({ id: "pool" }),
    expect.objectContaining({ id: "refreshed" }),
  ]);
  expect(refreshed).toHaveBeenCalledOnce();
});

it("refreshes scheduler summaries and tolerates legacy storage doubles", async () => {
  const state = createControlPlaneState();
  state.workspacePools.set("stale", {
    id: "stale",
    name: "stale",
    setupProfiles: [],
    destroyWorkspaceAfter: false,
    createdAt: "now",
    updatedAt: "now",
  });
  await expect(listWorkspacePoolSummariesDurable(state)).resolves.toEqual([
    expect.objectContaining({ id: "stale" }),
  ]);

  const storage = {
    listWorkspacePoolSummaries: vi.fn(async () => [
      {
        id: "z",
        name: "same",
        setupProfiles: [],
        destroyWorkspaceAfter: false,
        createdAt: "now",
        updatedAt: "now",
      },
      {
        id: "a",
        name: "same",
        setupProfiles: [],
        destroyWorkspaceAfter: false,
        createdAt: "now",
        updatedAt: "now",
      },
    ]),
  };
  state.storage = storage as never;
  await expect(listWorkspacePoolSummariesDurable(state)).resolves.toEqual([
    expect.objectContaining({ id: "a" }),
    expect.objectContaining({ id: "z" }),
  ]);
  expect(state.workspacePools.get("a")).toMatchObject({ id: "a" });
});

it("returns null for a missing durable public summary", async () => {
  const state = createControlPlaneState({
    storage: { getWorkspacePoolSummary: vi.fn(async () => null) } as never,
  });
  await expect(getWorkspacePoolPublicDurable(state, "missing")).resolves.toBeNull();
});

it("sorts public durable summaries by name and then id", async () => {
  const state = createControlPlaneState({
    storage: {
      listWorkspacePoolSummaries: async () => [
        { id: "z", name: "same", setupProfiles: [], destroyWorkspaceAfter: false },
        { id: "a", name: "same", setupProfiles: [], destroyWorkspaceAfter: false },
      ],
    } as never,
  });
  await expect(listWorkspacePoolsPublicDurable(state)).resolves.toEqual([
    expect.objectContaining({ id: "a" }),
    expect.objectContaining({ id: "z" }),
  ]);
});

it("allows local deletion when only inactive sessions reference a pool", async () => {
  const plane = new ControlPlane({ workspacePoolIdFactory: () => "pool" });
  expect(plane.createWorkspacePool({ name: "pool" }).ok).toBe(true);
  plane.state.sessions.set("completed", {
    id: "completed",
    workspacePoolId: "pool",
    status: "completed",
  } as never);
  await expect(plane.deleteWorkspacePoolDurable("pool")).resolves.toEqual({ ok: true });
});
