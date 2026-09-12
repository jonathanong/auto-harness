import { describe, expect, it } from "vitest";

import { reclaimStaleHostsDurable } from "./control-plane-lifecycle.ts";
import { createControlPlaneState } from "./control-plane-state.ts";
import { setDurableReadStorage } from "../test-helpers/control-plane-durable-read-test-helpers.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const STALE = "2000-01-01T00:00:00.000Z";

describe("durable stale-host candidate selection", () => {
  it("skips a hostConnection row whose live connection is already gone", async () => {
    const state = createControlPlaneState({ heartbeatStaleMs: 1, now: () => NOW });
    setDurableReadStorage(state, {
      listWorktreesByHost: async () => [],
      releaseHostConnection: async () => true,
    });
    state.hostConnection.set("ghost", "missing-connection");
    await expect(reclaimStaleHostsDurable(state, Date.parse(NOW))).resolves.toEqual([]);
    expect(state.hostConnection.has("ghost")).toBe(true);
  });

  it("does not replace a live stale candidate with a disconnected-host observation", async () => {
    const released: string[] = [];
    const state = createControlPlaneState({ heartbeatStaleMs: 1, now: () => NOW });
    setDurableReadStorage(state, {
      listWorktreesByHost: async () => [],
      releaseHostConnection: async (hostId: string) => {
        released.push(hostId);
        return true;
      },
    });
    state.connections.set("connection", {
      hostId: "host",
      connectionId: "connection",
      type: "host",
      connectedAt: STALE,
      lastHeartbeatAt: STALE,
      commandProfiles: [],
      capabilities: [],
      repositoryIds: [],
    });
    state.hostConnection.set("host", "connection");
    state.disconnectedHosts.set("host", { lastHeartbeatAt: NOW });
    await expect(reclaimStaleHostsDurable(state, Date.parse(NOW))).resolves.toEqual([]);
    expect(released).toEqual(["host"]);
  });

  it("keeps a remapped hostConnection when the lease-release loses", async () => {
    const state = createControlPlaneState({ heartbeatStaleMs: 1, now: () => NOW });
    setDurableReadStorage(state, {
      listWorktreesByHost: async () => [],
      releaseHostConnection: async () => {
        state.hostConnection.set("host", "replacement");
        return false;
      },
    });
    state.connections.set("connection", {
      hostId: "host",
      connectionId: "connection",
      type: "host",
      connectedAt: STALE,
      lastHeartbeatAt: STALE,
      commandProfiles: [],
      capabilities: [],
      repositoryIds: [],
    });
    state.hostConnection.set("host", "connection");
    await expect(reclaimStaleHostsDurable(state, Date.parse(NOW))).resolves.toEqual([]);
    expect(state.hostConnection.get("host")).toBe("replacement");
    expect(state.connections.has("connection")).toBe(false);
  });
});
