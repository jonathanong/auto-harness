import { describe, expect, it } from "vitest";

import { hydrateFromStorage } from "./control-plane-hydrate.ts";
import { createControlPlaneState } from "./control-plane-state.ts";

describe("durable hydration boundary records", () => {
  it("retains eligible leases while normalizing legacy connection and catalog defaults", async () => {
    const running = {
      id: "running",
      repositoryId: "repo",
      status: "running",
      hostId: "host",
      providerAccountLease: {
        concurrencyId: "account:0",
        attemptId: "attempt",
        slot: 0,
        providerAccountId: "account",
      },
    };
    const queued = {
      ...running,
      id: "queued",
      status: "queued",
      providerAccountLease: { ...running.providerAccountLease, concurrencyId: "account:1" },
    };
    const state = createControlPlaneState({
      storage: {
        listAllSessions: async () => [running, queued],
        listAllWorktrees: async () => [],
        listConnections: async () => [
          { connectionId: "ignored", type: "host", hostId: "ignored", registered: false },
          { connectionId: "legacy", type: "host", hostId: "host", capabilities: [] },
        ],
        listSchedules: async () => [{ id: "schedule", concurrencyId: "   " }],
        listRepositories: async () => [],
        listHostInventories: async () => [],
        listProviders: async () => [],
        listProviderAccounts: async () => [{ id: "account" }],
        listCommands: async () => [],
        listArchives: async () => [],
        listAllAuditLogs: async () => [],
        listLogs: async () => [],
      } as never,
    });

    await hydrateFromStorage(state);

    expect(state.providerAccountLeases.get("account:0")).toMatchObject({ sessionId: "running" });
    expect(state.providerAccountLeases.has("account:1")).toBe(false);
    expect(state.connections.get("legacy")?.runtime).toMatchObject({
      daemonVersion: "legacy/unknown",
    });
    expect(state.hostConnection.has("ignored")).toBe(false);
    expect(state.schedules.get("schedule")?.concurrencyId).toBe("schedule-schedule");
    expect(state.providerAccounts.get("account")?.maxConcurrentSessions).toBeGreaterThan(0);
  });
});
