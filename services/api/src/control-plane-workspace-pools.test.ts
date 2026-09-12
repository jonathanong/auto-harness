import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";

describe("workspace pool catalog", () => {
  it("creates opt-in pools with private, pool-local setup profiles", () => {
    const plane = new ControlPlane({
      now: () => "2026-09-12T00:00:00.000Z",
      workspacePoolIdFactory: () => "pool-1",
    });

    expect(
      plane.createWorkspacePool({
        name: "research",
        setupProfiles: [{ id: "python", name: "Python", script: "uv sync" }],
        defaultSetupProfileId: "python",
      }),
    ).toEqual({
      ok: true,
      workspacePool: {
        id: "pool-1",
        name: "research",
        setupProfiles: [{ id: "python", name: "Python", script: "uv sync" }],
        defaultSetupProfileId: "python",
        destroyWorkspaceAfter: false,
        createdAt: "2026-09-12T00:00:00.000Z",
        updatedAt: "2026-09-12T00:00:00.000Z",
      },
    });
    expect(plane.listWorkspacePoolsPublic()).toEqual([
      {
        id: "pool-1",
        name: "research",
        setupProfiles: [{ id: "python", name: "Python" }],
        defaultSetupProfileId: "python",
        destroyWorkspaceAfter: false,
        createdAt: "2026-09-12T00:00:00.000Z",
        updatedAt: "2026-09-12T00:00:00.000Z",
      },
    ]);
  });

  it("rejects duplicate profile ids and an unknown default", () => {
    const plane = new ControlPlane({ workspacePoolIdFactory: () => "pool" });
    expect(
      plane.createWorkspacePool({
        name: "research",
        setupProfiles: [
          { id: "same", name: "One", script: "one" },
          { id: "same", name: "Two", script: "two" },
        ],
      }),
    ).toEqual({ ok: false, error: "setup profile ids must be unique" });
    expect(
      plane.createWorkspacePool({
        name: "research",
        setupProfiles: [],
        defaultSetupProfileId: "missing",
      }),
    ).toEqual({ ok: false, error: "default setup profile does not exist: missing" });
  });

  it("validates pool identity and every trusted profile field", () => {
    const plane = new ControlPlane({ workspacePoolIdFactory: () => "pool" });
    expect(plane.createWorkspacePool({ name: "Not valid" })).toMatchObject({ ok: false });
    expect(
      plane.createWorkspacePool({
        name: "too-many",
        setupProfiles: Array.from({ length: 33 }, (_, index) => ({
          id: `profile-${index}`,
          name: "Profile",
          script: "true",
        })),
      }),
    ).toMatchObject({ ok: false, error: expect.stringContaining("at most 32") });
    expect(
      plane.createWorkspacePool({
        name: "bad-id",
        setupProfiles: [{ id: "Bad ID", name: "Profile", script: "true" }],
      }),
    ).toMatchObject({ ok: false, error: expect.stringContaining("setup profile id") });
    expect(
      plane.createWorkspacePool({
        name: "bad-name",
        setupProfiles: [{ id: "profile", name: " ", script: "true" }],
      }),
    ).toEqual({ ok: false, error: "setup profile name is required: profile" });
    expect(
      plane.createWorkspacePool({
        name: "blank-script",
        setupProfiles: [{ id: "profile", name: "Profile", script: " " }],
      }),
    ).toEqual({ ok: false, error: "setup profile script is required: profile" });
    expect(
      plane.createWorkspacePool({
        name: "long-script",
        setupProfiles: [{ id: "profile", name: "Profile", script: "x".repeat(65_537) }],
      }),
    ).toEqual({ ok: false, error: "setup profile script is too long: profile" });
  });

  it("updates, sorts, rejects collisions, and enforces local deletion dependencies", async () => {
    let id = 0;
    const plane = new ControlPlane({ workspacePoolIdFactory: () => `pool-${++id}` });
    expect(plane.createWorkspacePool({ name: "z-pool" }).ok).toBe(true);
    expect(
      plane.createWorkspacePool({
        id: "pool-1",
        name: "duplicate-id",
      }),
    ).toMatchObject({ ok: false, error: expect.stringContaining("already exists") });
    expect(plane.createWorkspacePool({ name: "a-pool" }).ok).toBe(true);
    expect(plane.createWorkspacePool({ name: "a-pool" })).toMatchObject({
      ok: false,
      error: expect.stringContaining("name already in use"),
    });
    expect(plane.listWorkspacePools().map((pool) => pool.name)).toEqual(["a-pool", "z-pool"]);
    expect(plane.updateWorkspacePool("missing", { name: "missing" })).toEqual({
      ok: false,
      error: "workspace pool not found",
    });
    expect(
      plane.updateWorkspacePool("pool-1", {
        name: "z-renamed",
        defaultSetupProfileId: null,
      }),
    ).toMatchObject({ ok: true, workspacePool: { name: "z-renamed" } });
    await expect(plane.getWorkspacePoolDurable("pool-1")).resolves.toMatchObject({
      name: "z-renamed",
    });

    plane.state.workspaceSlots.set("slot", {
      id: "slot",
      workspacePoolId: "pool-1",
      hostId: "host",
      name: "slot",
      path: "/tmp/slot",
      status: "idle",
      online: true,
      currentSessionId: null,
      updatedAt: "now",
    });
    await expect(plane.deleteWorkspacePoolDurable("pool-1")).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("attached"),
    });
    plane.state.workspaceSlots.clear();
    plane.state.schedules.set("schedule", {
      id: "schedule",
      repositoryId: "",
      workspacePoolId: "pool-1",
    } as never);
    await expect(plane.deleteWorkspacePoolDurable("pool-1")).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("schedule"),
    });
    plane.state.schedules.clear();
    plane.state.sessions.set("session", {
      id: "session",
      workspacePoolId: "pool-1",
      status: "queued",
    } as never);
    await expect(plane.deleteWorkspacePoolDurable("pool-1")).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("queued or running"),
    });
    plane.state.sessions.clear();
    await expect(plane.deleteWorkspacePoolDurable("pool-1")).resolves.toEqual({ ok: true });
    await expect(plane.deleteWorkspacePoolDurable("pool-1")).resolves.toEqual({
      ok: false,
      error: "workspace pool not found",
    });
  });
});
