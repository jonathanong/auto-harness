import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { parseHostMessage } from "./ws-hub.ts";

const worktrees = [{ id: "wt", name: "wt", repositoryId: "repo", path: "/repo/wt", labels: [] }];

describe("host capability advertisements", () => {
  it("accepts only known wire capabilities", () => {
    expect(
      parseHostMessage({
        type: "host:register",
        hostId: "host",
        worktrees,
        commandProfiles: [],
        capabilities: ["scheduled-main-checkout"],
      }),
    ).toMatchObject({ capabilities: ["scheduled-main-checkout"] });
    expect(
      parseHostMessage({
        type: "host:register",
        hostId: "host",
        worktrees,
        capabilities: { features: ["scheduled-main-checkout"], maxConcurrentAssignments: 4 },
        providerAccountReadiness: [
          { providerAccountId: "acct", ready: true, fingerprint: "a".repeat(64) },
        ],
      }),
    ).toMatchObject({
      capabilities: ["scheduled-main-checkout"],
      maxConcurrentAssignments: 4,
      providerAccountReadiness: [
        { providerAccountId: "acct", ready: true, fingerprint: "a".repeat(64) },
      ],
    });
    expect(
      parseHostMessage({
        type: "host:register",
        hostId: "host",
        worktrees,
        commandProfiles: [],
        capabilities: ["not-real"],
      }),
    ).toBeNull();
    expect(
      parseHostMessage({
        type: "host:register",
        hostId: "host",
        worktrees,
        commandProfiles: [],
        capabilities: ["scheduled-main-checkout", "scheduled-main-checkout"],
      }),
    ).toBeNull();
  });

  it("stores assignment capacity and provider-account readiness on the connection", () => {
    const plane = new ControlPlane({ connectionIdFactory: () => "capped" });
    expect(
      plane.registerHost({
        hostId: "capped",
        worktrees: [
          { id: "wt-cap", name: "wt-cap", repositoryId: "repo", path: "/repo/wt", labels: [] },
        ],
        commandProfiles: [],
        capabilities: ["scheduled-main-checkout"],
        maxConcurrentAssignments: 2,
        providerAccountReadiness: [
          { providerAccountId: "acct", ready: true, fingerprint: "a".repeat(64) },
        ],
      }).ok,
    ).toBe(true);
    const capped = plane.state.connections.get("capped");
    expect(capped?.maxConcurrentAssignments).toBe(2);
    expect(capped?.providerAccountReadiness?.[0]?.providerAccountId).toBe("acct");
  });

  it("forwards assignment capacity and readiness through durable registration", async () => {
    const plane = new ControlPlane({ connectionIdFactory: () => "durable-ready" });
    expect(
      (
        await plane.handleHostMessageDurable({
          type: "host:register",
          hostId: "durable-ready",
          worktrees: [
            { id: "wt-d", name: "wt-d", repositoryId: "repo", path: "/repo/wt", labels: [] },
          ],
          maxConcurrentAssignments: 3,
          providerAccountReadiness: [
            { providerAccountId: "acct", ready: true, fingerprint: "a".repeat(64) },
          ],
        })
      ).ok,
    ).toBe(true);
    const conn = plane.state.connections.get("durable-ready");
    expect(conn?.maxConcurrentAssignments).toBe(3);
    expect(conn?.providerAccountReadiness?.[0]?.providerAccountId).toBe("acct");
  });

  it("replaces a capability with an older reconnect advertisement", () => {
    const plane = new ControlPlane({ connectionIdFactory: () => "first" });
    expect(
      plane.registerHost({
        hostId: "host",
        worktrees,
        commandProfiles: [],
        capabilities: ["scheduled-main-checkout"],
      }).ok,
    ).toBe(true);
    expect(plane.listHosts()[0]?.capabilities).toEqual(["scheduled-main-checkout"]);

    plane.state.connectionIdFactory = () => "second";
    expect(
      plane.registerHost({
        hostId: "host",
        worktrees,
        commandProfiles: [],
        replaceExisting: true,
      }).ok,
    ).toBe(true);
    expect(plane.listHosts()[0]?.capabilities).toEqual([]);
  });

  it("stores inventory capabilities and defaults a legacy inventory to none", () => {
    const plane = new ControlPlane();
    const capable = plane.putHostInventory("capable", {
      repositories: [],
      commandProfiles: {},
      capabilities: ["scheduled-main-checkout"],
    });
    expect(capable).toMatchObject({
      ok: true,
      config: { capabilities: ["scheduled-main-checkout"] },
    });

    const legacy = plane.putHostInventory("legacy", { repositories: [], commandProfiles: {} });
    expect(legacy).toMatchObject({ ok: true, config: { capabilities: [] } });
    expect(
      plane.putHostInventory("bad", {
        repositories: [],
        commandProfiles: {},
        capabilities: ["not-real"],
      }).ok,
    ).toBe(false);
    expect(
      plane.putHostInventory("duplicate", {
        repositories: [],
        commandProfiles: {},
        capabilities: ["scheduled-main-checkout", "scheduled-main-checkout"],
      }).ok,
    ).toBe(false);
  });

  it("hydrates old durable connection and inventory records as unsupported", async () => {
    const plane = new ControlPlane();
    plane.state.storage = {
      putAuditLog: async () => undefined,
      listAuditLogs: async () => ({ items: [] }),
      listAllAuditLogs: async () => [],
      listAllSessions: async () => [],
      listAllWorktrees: async () => [],
      listConnections: async () => [
        {
          connectionId: "legacy-connection",
          type: "host",
          hostId: "legacy-connection-host",
          connectedAt: "then",
          lastHeartbeatAt: "then",
          commandProfiles: [],
        },
      ],
      listSchedules: async () => [],
      listRepositories: async () => [],
      listHostInventories: async () => [
        {
          hostId: "legacy-inventory-host",
          repositories: [],
          providerAccounts: [],
          commandProfiles: {},
          updatedAt: "then",
        },
      ],
      listProviders: async () => [],
      listProviderAccounts: async () => [],
      listCommands: async () => [],
      listArchives: async () => [],
    } as never;
    await plane.hydrateFromStorage();
    expect(
      plane.listHosts().find((host) => host.hostId === "legacy-connection-host")?.capabilities,
    ).toEqual([]);
    expect(plane.getHostInventory("legacy-inventory-host")?.capabilities).toEqual([]);
  });
});
