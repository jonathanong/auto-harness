/* eslint-disable max-lines -- advertisement, durable register, and hydrate cases share fixtures. */
import { HOST_PROTOCOL_VERSION } from "@auto-harness/shared";
import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { parseHostMessage } from "./ws-hub.ts";

const worktrees = [{ id: "wt", name: "wt", repositoryId: "repo", path: "/repo/wt", labels: [] }];
const requiredRegister = {
  protocolVersion: HOST_PROTOCOL_VERSION,
  daemonInstanceId: "123e4567-e89b-42d3-a456-426614174000",
  daemonStartedAt: "2026-08-11T00:00:00.000Z",
  runningAttempts: [] as { sessionId: string; attemptId: string }[],
  runtime: { daemonVersion: "test", gitVersion: "2.36.0", gitReady: true },
};

describe("host capability advertisements", () => {
  it("accepts only known wire capabilities", () => {
    expect(
      parseHostMessage({
        type: "host:register",
        hostId: "host",
        worktrees,
        commandProfiles: [],
        capabilities: { features: ["scheduled-main-checkout"] },
        ...requiredRegister,
      }),
    ).toMatchObject({
      capabilities: { features: ["scheduled-main-checkout"], maxConcurrentAssignments: 64 },
    });
    expect(
      parseHostMessage({
        type: "host:register",
        hostId: "host",
        worktrees,
        ...requiredRegister,
        capabilities: { features: ["scheduled-main-checkout"], maxConcurrentAssignments: 4 },
        providerAccountReadiness: [
          {
            providerAccountId: "acct",
            ready: true,
            fingerprint: "a".repeat(64),
            home: "/secret",
          },
        ],
      }),
    ).toMatchObject({
      capabilities: { features: ["scheduled-main-checkout"], maxConcurrentAssignments: 4 },
      providerAccountReadiness: [
        { providerAccountId: "acct", ready: true, fingerprint: "a".repeat(64) },
      ],
    });
    expect(
      parseHostMessage({
        type: "host:register",
        hostId: "host",
        worktrees,
        ...requiredRegister,
        capabilities: { features: ["scheduled-main-checkout"] },
        maxConcurrentAssignments: 4,
      }),
    ).toBeNull();
    expect(
      parseHostMessage({
        type: "host:register",
        hostId: "host",
        worktrees,
        ...requiredRegister,
        providerAccountReadiness: [
          {
            providerAccountId: "acct",
            ready: true,
            fingerprint: "a".repeat(64),
            home: "/secret",
          },
        ],
      })?.providerAccountReadiness?.[0],
    ).not.toHaveProperty("home");
    expect(
      parseHostMessage({
        type: "host:register",
        hostId: "host",
        worktrees,
        commandProfiles: [],
        ...requiredRegister,
        maxConcurrentAssignments: 8,
      }),
    ).toBeNull();
    expect(
      parseHostMessage({
        type: "host:register",
        hostId: "host",
        worktrees,
        commandProfiles: [],
        ...requiredRegister,
        capabilities: ["not-real"],
      }),
    ).toBeNull();
    expect(
      parseHostMessage({
        type: "host:register",
        hostId: "host",
        worktrees,
        commandProfiles: [],
        ...requiredRegister,
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
          {
            providerAccountId: "acct",
            ready: true,
            fingerprint: "a".repeat(64),
            home: "/secret",
          } as never,
        ],
      }).ok,
    ).toBe(true);
    const capped = plane.state.connections.get("capped");
    expect(capped?.maxConcurrentAssignments).toBe(2);
    expect(capped?.providerAccountReadiness?.[0]?.providerAccountId).toBe("acct");
    expect(capped?.providerAccountReadiness?.[0]).not.toHaveProperty("home");
  });

  it("forwards assignment capacity and readiness through durable registration", async () => {
    let n = 0;
    const plane = new ControlPlane({ connectionIdFactory: () => `durable-ready-${++n}` });
    expect(
      (
        await plane.handleHostMessageDurable({
          type: "host:register",
          hostId: "durable-ready",
          worktrees: [
            { id: "wt-d", name: "wt-d", repositoryId: "repo", path: "/repo/wt", labels: [] },
          ],
          ...requiredRegister,
          maxConcurrentAssignments: 3,
          providerAccountReadiness: [
            { providerAccountId: "acct", ready: true, fingerprint: "a".repeat(64) },
          ],
        })
      ).ok,
    ).toBe(true);
    const conn = plane.state.connections.get("durable-ready-1");
    expect(conn?.maxConcurrentAssignments).toBe(3);
    expect(conn?.providerAccountReadiness?.[0]?.providerAccountId).toBe("acct");

    expect(
      (
        await plane.handleHostMessageDurable({
          type: "host:register",
          hostId: "durable-features",
          worktrees: [
            { id: "wt-f", name: "wt-f", repositoryId: "repo", path: "/repo/wt", labels: [] },
          ],
          ...requiredRegister,
          capabilities: { features: ["scheduled-main-checkout"], maxConcurrentAssignments: 5 },
        } as never)
      ).ok,
    ).toBe(true);
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
        {
          connectionId: "current-connection",
          type: "host",
          hostId: "current-connection-host",
          connectedAt: "then",
          lastHeartbeatAt: "then",
          protocolVersion: HOST_PROTOCOL_VERSION,
          negotiatedProtocolVersion: HOST_PROTOCOL_VERSION,
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
    // The stored connection row predates `negotiatedProtocolVersion`, so it can
    // never be verified against HOST_PROTOCOL_VERSION. Hydration fails closed:
    // the host is dropped entirely rather than resurrected with an assumed
    // (empty) capability set.
    expect(
      plane.listHosts().find((host) => host.hostId === "legacy-connection-host"),
    ).toBeUndefined();
    // A row that actually carries a negotiated version matching the current
    // protocol hydrates normally (proving the guard discriminates), and a
    // legacy row missing `capabilities` normalizes to an empty list.
    expect(
      plane.listHosts().find((host) => host.hostId === "current-connection-host")?.capabilities,
    ).toEqual([]);
    // Host inventory rows are not gated by protocol negotiation; a legacy row
    // missing `capabilities` is normalized to an empty (unsupported) list.
    expect(plane.getHostInventory("legacy-inventory-host")?.capabilities).toEqual([]);
  });
});
