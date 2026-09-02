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

  it("never fetches per-session logs or the full audit log table during hydration", async () => {
    // Regression guard: hydrateFromStorage used to call listLogs once per session
    // (unbounded, O(sessions)) and listAllAuditLogs (a full-table scan) to populate
    // in-memory caches that no reader consults once durable storage is present —
    // getLogsDurable, archiveBody, and hydrateSlackSnapshotInputs all read DynamoDB
    // directly in that mode. That cost grew with history until it pushed the REST
    // Lambda's cold start past its own timeout and took production down. Cold-start
    // cost here must stay independent of session/log/audit-log volume.
    let listLogsCalls = 0;
    let listAllAuditLogsCalls = 0;
    const sessions = Array.from({ length: 25 }, (_, i) => ({
      id: `session-${i}`,
      repositoryId: "repo",
      status: "completed",
    }));
    const state = createControlPlaneState({
      storage: {
        listAllSessions: async () => sessions,
        listAllWorktrees: async () => [],
        listConnections: async () => [],
        listSchedules: async () => [],
        listRepositories: async () => [],
        listHostInventories: async () => [],
        listProviders: async () => [],
        listProviderAccounts: async () => [],
        listCommands: async () => [],
        listArchives: async () => [],
        listAllAuditLogs: async () => {
          listAllAuditLogsCalls += 1;
          return [];
        },
        listLogs: async () => {
          listLogsCalls += 1;
          return [];
        },
      } as never,
    });

    await hydrateFromStorage(state);

    expect(listLogsCalls).toBe(0);
    expect(listAllAuditLogsCalls).toBe(0);
    expect(state.logs.size).toBe(0);
    expect(state.auditLogs.size).toBe(0);
  });
});
