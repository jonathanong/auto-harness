import { describe, expect, it, vi } from "vitest";

import type { DynamoPlaneStorage } from "./db/plane-storage.ts";
import { ControlPlane } from "./control-plane.ts";

const noop = async () => undefined;
const emptyList = async () => [];

/** Minimal mock: only what hydrateFromStorage touches — this test targets providers only. */
function mockStorage(): DynamoPlaneStorage {
  return {
    putSession: vi.fn(noop),
    putWorktree: vi.fn(noop),
    putConnection: vi.fn(noop),
    putLog: vi.fn(noop),
    putSchedule: vi.fn(noop),
    putRepository: vi.fn(noop),
    putArchive: vi.fn(noop),
    putAgentHost: vi.fn(noop),
    listAllSessions: vi.fn(emptyList),
    listAllWorktrees: vi.fn(emptyList),
    listConnections: vi.fn(emptyList),
    listSchedules: vi.fn(emptyList),
    listRepositories: vi.fn(emptyList),
    listArchives: vi.fn(emptyList),
    listAgentHosts: vi.fn(emptyList),
    listProviders: vi.fn(async () => [
      { id: "prov-1", name: "claude", defaultCommandId: null, createdAt: "t", updatedAt: "t" },
    ]),
    listProviderAccounts: vi.fn(async () => [
      { id: "acct-1", providerId: "prov-1", label: "a@b.com", createdAt: "t", updatedAt: "t" },
    ]),
    listCommands: vi.fn(async () => [
      {
        id: "cmd-1",
        name: "claude-print",
        argv: ["claude", "-p"],
        appendPrompt: true,
        providerId: "prov-1",
        createdAt: "t",
        updatedAt: "t",
      },
    ]),
  } as unknown as DynamoPlaneStorage;
}

describe("ControlPlane storage write-through paths — providers", () => {
  it("hydrates providers/provider-accounts/commands and wires id factories", async () => {
    const plane = new ControlPlane({
      storage: mockStorage(),
      providerIdFactory: () => "prov-new",
      providerAccountIdFactory: () => "acct-new",
      commandIdFactory: () => "cmd-new",
      now: () => "2026-01-01T00:00:00.000Z",
    });

    await plane.hydrateFromStorage();
    expect(plane.state.providers.has("prov-1")).toBe(true);
    expect(plane.state.providerAccounts.has("acct-1")).toBe(true);
    expect(plane.state.commands.has("cmd-1")).toBe(true);
    expect(plane.state.providerIdFactory()).toBe("prov-new");
    expect(plane.state.providerAccountIdFactory()).toBe("acct-new");
    expect(plane.state.commandIdFactory()).toBe("cmd-new");
  });

  it("defaults id factories to newId when not provided", () => {
    const plane = new ControlPlane({});
    expect(typeof plane.state.providerIdFactory()).toBe("string");
    expect(typeof plane.state.providerAccountIdFactory()).toBe("string");
    expect(typeof plane.state.commandIdFactory()).toBe("string");
  });
});
