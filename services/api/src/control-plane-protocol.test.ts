import { describe, expect, it } from "vitest";

import {
  connectionProtocolVersion,
  durableConnectionProtocolVersion,
  negotiateHostProtocolVersion,
} from "./control-plane-protocol.ts";
import { hydrateFromStorage } from "./control-plane-hydrate.ts";
import { createControlPlaneState } from "./control-plane-state.ts";

describe("host connection protocol negotiation", () => {
  it("caps the advertised version at the control plane's implementation", () => {
    expect(negotiateHostProtocolVersion(undefined)).toBe(0);
    expect(negotiateHostProtocolVersion(4)).toBe(4);
    expect(negotiateHostProtocolVersion(99)).toBe(7);
  });

  it("uses an explicit durable negotiation before a legacy advertisement", () => {
    expect(connectionProtocolVersion(undefined)).toBe(0);
    expect(connectionProtocolVersion({ protocolVersion: 4 })).toBe(4);
    expect(connectionProtocolVersion({ protocolVersion: 7, negotiatedProtocolVersion: 3 })).toBe(3);
    expect(durableConnectionProtocolVersion(undefined)).toBe(0);
    expect(durableConnectionProtocolVersion({ negotiatedProtocolVersion: 7 })).toBe(7);
  });

  it("fails closed after an upgrade reads an old control plane's advertisement", async () => {
    const state = createControlPlaneState({
      storage: {
        listAllSessions: async () => [],
        listAllWorktrees: async () => [],
        listConnections: async () => [
          // Old v3 control planes stored the daemon's v7 advertisement but
          // could not have negotiated its later terminal-handoff semantics.
          { connectionId: "old", type: "host", hostId: "host", protocolVersion: 7 },
        ],
        listSchedules: async () => [],
        listRepositories: async () => [],
        listWorkspacePools: async () => [],
        listWorkspaceSlots: async () => [],
        listHostInventories: async () => [],
        listProviders: async () => [],
        listProviderAccounts: async () => [],
        listCommands: async () => [],
        listArchives: async () => [],
      } as never,
    });

    await hydrateFromStorage(state);

    expect(connectionProtocolVersion(state.connections.get("old"))).toBe(0);
    expect(state.connections.get("old")?.negotiatedProtocolVersion).toBe(0);
  });
});
