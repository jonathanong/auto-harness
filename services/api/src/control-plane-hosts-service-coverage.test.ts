import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";

describe("getHostDurable residual coverage", () => {
  it("reuses a matching worktree page cursor", async () => {
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
        listWorktreesPage: async () => ({ items: [record], nextKey: { id: "wt-1" } }),
      } as never,
    });
    const page = await plane.listWorktreesPageDurable({
      limit: 1,
      cursor: null,
      hostId: "host-a",
      repositoryId: "repo-1",
    });
    await expect(
      plane.listWorktreesPageDurable({
        limit: 1,
        cursor: page.nextCursor,
        hostId: "host-a",
        repositoryId: "repo-1",
      }),
    ).resolves.toMatchObject({ items: [{ id: "wt-1" }] });
  });

  it("hydrates inventory without a host lock reader", async () => {
    const plane = new ControlPlane({
      storage: {
        getHostInventory: async () => ({
          hostId: "host-4",
          repositories: [],
          providerAccounts: [],
          updatedAt: "t",
        }),
      } as never,
    });
    await expect(plane.getHostDurable("host-4")).resolves.toMatchObject({
      hostId: "host-4",
      online: false,
    });
  });

  it("clears a stale drainingHosts entry once the durable lock reports draining: false", async () => {
    // Reproduces the live bug: a warm container that served POST /hosts/drain keeps
    // `drainingHosts` set even after the daemon re-registers and the durable lock's
    // draining flag clears. getHostDurable must delete, not just add, on refresh.
    const connection = {
      connectionId: "connection",
      type: "host" as const,
      hostId: "host-5",
      connectedAt: "t",
      lastHeartbeatAt: "t",
    };
    const plane = new ControlPlane({
      storage: {
        getHostInventory: async () => ({
          hostId: "host-5",
          repositories: [],
          providerAccounts: [],
          updatedAt: "t",
        }),
        getHostLock: async () => connection.connectionId,
        getConnection: async (id: string) => (id === connection.connectionId ? connection : null),
        getHostLockState: async () => ({ connectionId: connection.connectionId, draining: false }),
      } as never,
    });
    plane.state.drainingHosts.add("host-5");

    await expect(plane.getHostDurable("host-5")).resolves.toMatchObject({
      hostId: "host-5",
      online: true,
      draining: false,
    });
    expect(plane.state.drainingHosts.has("host-5")).toBe(false);
  });

  it("still reports a genuinely draining host as draining from the detail endpoint", async () => {
    const connection = {
      connectionId: "connection",
      type: "host" as const,
      hostId: "host-6",
      connectedAt: "t",
      lastHeartbeatAt: "t",
    };
    const plane = new ControlPlane({
      storage: {
        getHostInventory: async () => ({
          hostId: "host-6",
          repositories: [],
          providerAccounts: [],
          updatedAt: "t",
        }),
        getHostLock: async () => connection.connectionId,
        getConnection: async (id: string) => (id === connection.connectionId ? connection : null),
        getHostLockState: async () => ({ connectionId: connection.connectionId, draining: true }),
      } as never,
    });

    await expect(plane.getHostDurable("host-6")).resolves.toMatchObject({
      hostId: "host-6",
      online: true,
      draining: true,
    });
    expect(plane.state.drainingHosts.has("host-6")).toBe(true);
  });

  it("keeps list and detail agreeing on drain state as the durable lock changes", async () => {
    let draining = true;
    const connection = {
      connectionId: "connection",
      type: "host" as const,
      hostId: "host-7",
      connectedAt: "t",
      lastHeartbeatAt: "t",
    };
    const plane = new ControlPlane({
      storage: {
        listConnections: async () => [connection],
        listHostInventories: async () => [],
        listRepositories: async () => [],
        listCommands: async () => [],
        listProviders: async () => [],
        listProviderAccounts: async () => [],
        getHostInventory: async () => null,
        getHostLock: async () => connection.connectionId,
        getConnection: async (id: string) => (id === connection.connectionId ? connection : null),
        getHostLockState: async () => ({ connectionId: connection.connectionId, draining }),
      } as never,
    });

    const listedDraining = await plane.listHostsDurable();
    const detailDraining = await plane.getHostDurable("host-7");
    expect(listedDraining.find((host) => host.hostId === "host-7")?.draining).toBe(true);
    expect(detailDraining?.draining).toBe(true);

    draining = false;
    const listedCleared = await plane.listHostsDurable();
    const detailCleared = await plane.getHostDurable("host-7");
    expect(listedCleared.find((host) => host.hostId === "host-7")?.draining).toBe(false);
    expect(detailCleared?.draining).toBe(false);
  });
});
