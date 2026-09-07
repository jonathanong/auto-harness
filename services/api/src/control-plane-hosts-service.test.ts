import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";

describe("getHostDurable", () => {
  it("loads one host from keyed inventory and lock reads", async () => {
    const inventories = new Map([
      ["host-1", { hostId: "host-1", repositories: [], providerAccounts: [], updatedAt: "t" }],
    ]);
    const connections = new Map([
      [
        "conn-1",
        {
          connectionId: "conn-1",
          type: "host" as const,
          hostId: "host-1",
          connectedAt: "t",
          lastHeartbeatAt: "t",
        },
      ],
    ]);
    const plane = new ControlPlane({
      storage: {
        getHostInventory: async (id: string) => inventories.get(id) ?? null,
        getHostLock: async () => "conn-1",
        getConnection: async (id: string) => connections.get(id) ?? null,
      } as never,
    });
    await expect(plane.getHostDurable("host-1")).resolves.toMatchObject({
      hostId: "host-1",
      online: true,
    });
    await expect(plane.getHostDurable("missing")).resolves.toBeNull();
    connections.set("conn-1", {
      connectionId: "conn-1",
      type: "client",
      hostId: "host-1",
      connectedAt: "t",
      lastHeartbeatAt: "t",
    });
    await expect(plane.getHostDurable("host-1")).resolves.toMatchObject({ hostId: "host-1" });
    connections.set("conn-2", {
      connectionId: "conn-2",
      type: "host",
      hostId: "host-1",
      connectedAt: "t2",
      lastHeartbeatAt: "t2",
    });
    const rotated = new ControlPlane({
      storage: {
        getHostInventory: async () => inventories.get("host-1") ?? null,
        getHostLock: async () => "conn-2",
        getConnection: async (id: string) => connections.get(id) ?? null,
      } as never,
    });
    rotated.state.hostConnection.set("host-1", "conn-1");
    rotated.state.connections.set("conn-1", connections.get("conn-1")!);
    await expect(rotated.getHostDurable("host-1")).resolves.toMatchObject({
      hostId: "host-1",
      online: true,
    });
    expect(rotated.state.hostConnection.get("host-1")).toBe("conn-2");
    expect(rotated.state.connections.has("conn-1")).toBe(false);
  });

  it("clears a cached host connection when the durable lock is gone", async () => {
    const plane = new ControlPlane({
      storage: {
        getHostInventory: async () => ({
          hostId: "host-1",
          repositories: [],
          providerAccounts: [],
          updatedAt: "t",
        }),
        getHostLock: async () => null,
        getConnection: async () => {
          throw new Error("should not load a connection without a lock");
        },
      } as never,
    });
    plane.state.connections.set("stale", {
      connectionId: "stale",
      type: "host",
      hostId: "host-1",
      connectedAt: "t",
      lastHeartbeatAt: "t",
    });
    plane.state.hostConnection.set("host-1", "stale");
    await expect(plane.getHostDurable("host-1")).resolves.toMatchObject({
      hostId: "host-1",
      online: false,
    });
    expect(plane.state.hostConnection.has("host-1")).toBe(false);
    expect(plane.state.connections.has("stale")).toBe(false);
  });

  it("skips connection hydration when the host lock is empty", async () => {
    const plane = new ControlPlane({
      storage: {
        getHostInventory: async () => ({
          hostId: "host-3",
          repositories: [],
          providerAccounts: [],
          updatedAt: "t",
        }),
        getHostLock: async () => null,
        getConnection: async () => {
          throw new Error("should not load a connection without a lock");
        },
      } as never,
    });
    await expect(plane.getHostDurable("host-3")).resolves.toMatchObject({
      hostId: "host-3",
      online: false,
    });
  });

  it("hydrates a worktree from storage and pages with a continuation key", async () => {
    const record = {
      id: "wt-1",
      name: "wt-1",
      hostId: "host-a",
      repositoryId: "repo-1",
      path: "/wt-1",
      labels: [],
      status: "idle" as const,
      online: true,
    };
    const plane = new ControlPlane({
      storage: {
        getWorktree: async (id: string) => (id === "wt-1" ? record : null),
        listWorktreesPage: async () => ({ items: [record], nextKey: { id: "wt-1" } }),
      } as never,
    });
    await expect(plane.getWorktreeDurable("wt-1")).resolves.toMatchObject({ id: "wt-1" });
    expect(plane.getWorktree("wt-1")?.id).toBe("wt-1");
    await expect(plane.getWorktreeDurable("missing")).resolves.toBeNull();
    const page = await plane.listWorktreesPageDurable({
      limit: 1,
      cursor: null,
      hostId: "host-a",
      repositoryId: "repo-1",
    });
    expect(page.nextCursor).toMatch(/^s1\./);
    expect(page.nextCursor).toContain(".");
    await expect(
      plane.listWorktreesPageDurable({
        limit: 1,
        cursor: page.nextCursor,
        hostId: "host-b",
        repositoryId: "repo-1",
      }),
    ).rejects.toThrow("invalid or mismatched list cursor");
  });

  it("pages in-memory worktrees by host and repository", async () => {
    const plane = new ControlPlane();
    const seed = (id: string, hostId: string, repositoryId: string) =>
      plane.seedWorktree({
        id,
        name: id,
        hostId,
        repositoryId,
        path: `/${id}`,
        labels: [],
        status: "idle",
        online: true,
      });
    seed("wt-a", "host-a", "repo-1");
    seed("wt-b", "host-b", "repo-1");
    seed("wt-c", "host-a", "repo-2");
    await expect(
      plane.listWorktreesPageDurable({
        limit: 10,
        cursor: null,
        hostId: "host-a",
        repositoryId: null,
      }),
    ).resolves.toMatchObject({ items: [{ id: "wt-a" }, { id: "wt-c" }], nextCursor: null });
    await expect(
      plane.listWorktreesPageDurable({
        limit: 10,
        cursor: null,
        hostId: null,
        repositoryId: "repo-1",
      }),
    ).resolves.toMatchObject({ items: [{ id: "wt-a" }, { id: "wt-b" }], nextCursor: null });
  });

  it("falls back to the in-memory fleet when storage has no keyed host reads", async () => {
    const plane = new ControlPlane({ storage: {} as never });
    plane.state.hostInventories.set("host-2", {
      hostId: "host-2",
      repositories: [],
      providerAccounts: [],
      updatedAt: "t",
    });
    await expect(plane.getHostDurable("host-2")).resolves.toMatchObject({ hostId: "host-2" });
  });
});
