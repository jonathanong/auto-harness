import { describe, expect, it } from "vitest";

import { HOST_PROTOCOL_VERSION } from "@auto-harness/shared";

import {
  connectionProtocolVersion,
  durableConnectionProtocolVersion,
  isCurrentHostProtocol,
  negotiateHostProtocolVersion,
} from "./control-plane-protocol.ts";
import { hydrateFromStorage } from "./control-plane-hydrate.ts";
import { createControlPlaneState } from "./control-plane-state.ts";

describe("host connection protocol negotiation", () => {
  it("accepts only the current host protocol", () => {
    expect(negotiateHostProtocolVersion(undefined)).toBeNull();
    expect(negotiateHostProtocolVersion(4)).toBeNull();
    expect(negotiateHostProtocolVersion(HOST_PROTOCOL_VERSION)).toBe(HOST_PROTOCOL_VERSION);
    expect(negotiateHostProtocolVersion(99)).toBeNull();
    expect(isCurrentHostProtocol(undefined)).toBe(false);
    expect(isCurrentHostProtocol(4)).toBe(false);
    expect(isCurrentHostProtocol(HOST_PROTOCOL_VERSION)).toBe(true);
  });

  it("reads the negotiated version without a zero default", () => {
    expect(connectionProtocolVersion(undefined)).toBeUndefined();
    expect(connectionProtocolVersion({ protocolVersion: 4 })).toBe(4);
    expect(connectionProtocolVersion({ protocolVersion: 7, negotiatedProtocolVersion: 7 })).toBe(7);
    expect(durableConnectionProtocolVersion(undefined)).toBeUndefined();
    expect(durableConnectionProtocolVersion({ negotiatedProtocolVersion: 7 })).toBe(7);
  });

  it("hydrates a stored advertisement without inventing a negotiated version", async () => {
    const state = createControlPlaneState({
      storage: {
        listAllSessions: async () => [],
        listAllWorktrees: async () => [],
        listConnections: async () => [
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

    expect(connectionProtocolVersion(state.connections.get("old"))).toBe(7);
    expect(state.connections.get("old")?.negotiatedProtocolVersion).toBe(7);
  });
});
