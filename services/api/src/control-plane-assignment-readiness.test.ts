import { describe, expect, it } from "vitest";

import { refreshAssignmentReadinessDurable } from "./control-plane-assignment-readiness.ts";
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
});
