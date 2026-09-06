import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { heartbeatDurable } from "./control-plane-agents.ts";

describe("durable heartbeat lease resolution", () => {
  it("resolves a heartbeat's lease from the durable lock when the local cache is stale", async () => {
    // A warm Lambda that never saw this host's most recent registration (or just
    // cold-started) has no local `hostConnection` entry. The durable lock is
    // authoritative and the write below is already fenced to it, so this must
    // succeed the same way `drainHostDurable` already falls back for drain.
    const plane = new ControlPlane({ now: () => "now" });
    let heartbeatConnectionCalledWith: [string, string, string] | undefined;
    plane.state.storage = {
      getHostLock: async () => "durable-owner",
      heartbeatConnection: async (hostId: string, connectionId: string, at: string) => {
        heartbeatConnectionCalledWith = [hostId, connectionId, at];
        return true;
      },
    } as never;
    expect(plane.state.hostConnection.has("h")).toBe(false);
    expect(await heartbeatDurable(plane.state, "h", "beat")).toBe(true);
    expect(heartbeatConnectionCalledWith).toEqual(["h", "durable-owner", "beat"]);
    // Deliberately does not backfill the local cache from this fallback lookup —
    // see the comment in heartbeatDurable for why a half-populated hostConnection
    // entry (with no matching `state.connections` row) would be worse than none.
    expect(plane.state.hostConnection.has("h")).toBe(false);
  });

  it("fails a heartbeat with no local cache and no durable lock owner", async () => {
    const plane = new ControlPlane();
    plane.state.storage = { getHostLock: async () => null } as never;
    expect(await heartbeatDurable(plane.state, "missing")).toBe(false);
  });
});
