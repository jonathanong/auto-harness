import { describe, expect, it } from "vitest";

import {
  hydrateAssignmentConnectionDurable,
  refreshAssignmentReadinessDurable,
} from "./control-plane-assignment-readiness.ts";
import { createControlPlaneState } from "./control-plane-state.ts";

const freshConnection = async () => ({
  connectionId: "connection",
  type: "host" as const,
  hostId: "host",
  connectedAt: "now",
  lastHeartbeatAt: "now",
  capabilities: [],
  providerAccountReadiness: [{ providerAccountId: "account", ready: true }],
});

describe("bounded assignment readiness", () => {
  it("refreshes selected connections and fails closed for the unrefreshed remainder", async () => {
    const state = createControlPlaneState({ shardCount: 1 });
    for (const [connectionId, readiness] of [
      ["connection", [{ providerAccountId: "account", ready: false }]],
      ["unrefreshed", [{ providerAccountId: "account", ready: true }]],
      ["legacy", undefined],
    ] as const) {
      state.connections.set(connectionId, {
        connectionId,
        type: "host",
        hostId: `${connectionId}-host`,
        connectedAt: "now",
        lastHeartbeatAt: "now",
        ...(readiness ? { providerAccountReadiness: readiness } : {}),
      });
    }
    state.storage = { getConnection: freshConnection } as never;

    await refreshAssignmentReadinessDurable(state, 1);

    expect(state.connections.get("connection")?.providerAccountReadiness).toEqual([
      { providerAccountId: "account", ready: true },
    ]);
    expect(state.connections.get("unrefreshed")?.providerAccountReadiness).toEqual([]);
  });

  it("drops bounded readiness rows that disappeared durably", async () => {
    const state = createControlPlaneState({ shardCount: 1 });
    for (const connectionId of ["missing", "unregistered"]) {
      state.connections.set(connectionId, {
        connectionId,
        type: "host",
        hostId: `${connectionId}-host`,
        connectedAt: "now",
        lastHeartbeatAt: "now",
      });
      state.hostConnection.set(`${connectionId}-host`, connectionId);
    }
    state.hostConnection.set("unrelated", "other");
    await refreshAssignmentReadinessDurable(state, 1);
    state.storage = {} as never;
    await refreshAssignmentReadinessDurable(state, 1);
    state.storage = {
      getConnection: async (connectionId: string) =>
        connectionId === "unregistered"
          ? { ...state.connections.get(connectionId)!, registered: false }
          : null,
    } as never;

    await refreshAssignmentReadinessDurable(state, 0);
    expect(state.connections.has("missing")).toBe(true);
    await refreshAssignmentReadinessDurable(state, 2);
    expect(state.connections.size).toBe(0);
    expect(state.hostConnection).toEqual(new Map([["unrelated", "other"]]));
  });

  it("hydrates live host sockets from storage when the worker map is empty", async () => {
    const live = {
      connectionId: "connection",
      type: "host" as const,
      hostId: "host",
      connectedAt: "now",
      lastHeartbeatAt: "now",
      capabilities: [],
      providerAccountReadiness: [{ providerAccountId: "account", ready: true }],
    };
    const state = createControlPlaneState({ shardCount: 1 });
    state.storage = {
      listConnections: async () => [
        live,
        { ...live, connectionId: "viewer", type: "client", hostId: "viewer" },
        { ...live, connectionId: "pending", registered: false },
      ],
      getConnection: async (connectionId: string) => (connectionId === "connection" ? live : null),
    } as never;

    await refreshAssignmentReadinessDurable(state, 8);

    expect([...state.connections.keys()]).toEqual(["connection"]);
    expect(state.hostConnection.get("host")).toBe("connection");
    expect(state.connections.get("connection")?.providerAccountReadiness).toEqual([
      { providerAccountId: "account", ready: true },
    ]);
  });

  it("leaves an empty worker map empty when storage cannot list sockets", async () => {
    const state = createControlPlaneState({ shardCount: 1 });
    state.storage = { getConnection: freshConnection } as never;

    await refreshAssignmentReadinessDurable(state, 8);

    expect(state.connections.size).toBe(0);
    expect(state.hostConnection.size).toBe(0);
  });

  it("seeds the source host socket used by a usage-limit requeue", async () => {
    const live = {
      connectionId: "source",
      type: "host" as const,
      hostId: "host",
      connectedAt: "now",
      lastHeartbeatAt: "now",
      capabilities: [],
      providerAccountReadiness: [{ providerAccountId: "fallback", ready: true }],
    };
    const state = createControlPlaneState({ shardCount: 1 });
    state.storage = {
      getConnection: async (connectionId: string) => (connectionId === "source" ? live : null),
    } as never;

    await hydrateAssignmentConnectionDurable(state, "source");

    expect(state.hostConnection.get("host")).toBe("source");
    expect(state.connections.get("source")?.providerAccountReadiness).toEqual([
      { providerAccountId: "fallback", ready: true },
    ]);
  });
});
