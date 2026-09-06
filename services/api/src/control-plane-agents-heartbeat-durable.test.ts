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

  it("prefers an already-fenced sourceConnectionId over a stale non-empty local cache", async () => {
    // handleHostMessageDurable already verifies the frame's own connectionId
    // against the durable lock before calling heartbeatDurable (its `fence`
    // check) — that is strictly stronger than this process's local cache,
    // which can still hold a *different*, superseded connectionId for this
    // host (not merely be empty) when another warm container registered a
    // replacement more recently. Using the stale cache value here would fail
    // the fenced write against the current lock for no reason.
    const plane = new ControlPlane();
    plane.state.hostConnection.set("h", "stale-cached-conn");
    let getHostLockCalls = 0;
    let heartbeatConnectionCalledWith: [string, string] | undefined;
    plane.state.storage = {
      getHostLock: async () => {
        getHostLockCalls += 1;
        return "stale-cached-conn";
      },
      heartbeatConnection: async (hostId: string, connectionId: string) => {
        heartbeatConnectionCalledWith = [hostId, connectionId];
        return connectionId === "current-conn";
      },
    } as never;
    expect(await heartbeatDurable(plane.state, "h", "beat", "current-conn")).toBe(true);
    expect(heartbeatConnectionCalledWith).toEqual(["h", "current-conn"]);
    // The already-fenced connectionId short-circuits both fallback lookups.
    expect(getHostLockCalls).toBe(0);
  });
});
