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
    const timedOut = {
      ...running,
      id: "timed",
      status: "timed_out",
      hostId: undefined,
      timedOutHostId: "timeout-host",
      providerAccountLease: { ...running.providerAccountLease, concurrencyId: "account:2" },
    };
    const hostless = {
      ...running,
      id: "hostless",
      hostId: undefined,
      providerAccountLease: { ...running.providerAccountLease, concurrencyId: "account:3" },
    };
    const state = createControlPlaneState({
      storage: {
        listAllSessions: async () => [running, queued, timedOut, hostless],
        listAllWorktrees: async () => [],
        listConnections: async () => [
          { connectionId: "ignored", type: "host", hostId: "ignored", registered: false },
          { connectionId: "legacy", type: "host", hostId: "host", capabilities: [] },
          { connectionId: "viewer-conn", type: "client", hostId: "user:alice" },
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

    expect(state.providerAccountLeases.get("account:0")).toMatchObject({
      sessionId: "running",
      hostId: "host",
    });
    expect(state.providerAccountLeases.get("account:2")).toMatchObject({
      sessionId: "timed",
      hostId: "timeout-host",
    });
    expect(state.providerAccountLeases.get("account:3")).toMatchObject({
      sessionId: "hostless",
      hostId: "",
    });
    expect(state.providerAccountLeases.has("account:1")).toBe(false);
    expect(state.connections.get("legacy")?.runtime).toMatchObject({
      daemonVersion: "legacy/unknown",
    });
    expect(state.hostConnection.has("ignored")).toBe(false);
    expect(state.connections.has("viewer-conn")).toBe(false);
    expect(state.hostConnection.has("user:alice")).toBe(false);
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

  it("skips the Sessions table Scan when sessionHistory is disabled", async () => {
    let listAllSessionsCalls = 0;
    const state = createControlPlaneState({
      storage: {
        listAllSessions: async () => {
          listAllSessionsCalls += 1;
          return [{ id: "session" }];
        },
        listAllWorktrees: async () => [],
        listConnections: async () => [],
        listSchedules: async () => [],
        listRepositories: async () => [],
        listHostInventories: async () => [],
        listProviders: async () => [],
        listProviderAccounts: async () => [],
        listCommands: async () => [],
        listArchives: async () => [],
      } as never,
    });
    await hydrateFromStorage(state, { sessionHistory: false });
    expect(listAllSessionsCalls).toBe(0);
    expect(state.sessions.size).toBe(0);
  });

  it("skips catalog Scans when catalogs is disabled", async () => {
    let listHostInventoriesCalls = 0;
    let listAllWorktreesCalls = 0;
    let listConnectionsCalls = 0;
    const state = createControlPlaneState({
      storage: {
        listAllSessions: async () => [{ id: "session" }],
        listAllWorktrees: async () => {
          listAllWorktreesCalls += 1;
          return [];
        },
        listConnections: async () => {
          listConnectionsCalls += 1;
          return [];
        },
        listSchedules: async () => [],
        listRepositories: async () => [],
        listHostInventories: async () => {
          listHostInventoriesCalls += 1;
          return [];
        },
        listProviders: async () => [],
        listProviderAccounts: async () => [],
        listCommands: async () => [],
        listArchives: async () => [],
      } as never,
    });
    await hydrateFromStorage(state, { sessionHistory: false, catalogs: false });
    expect(listHostInventoriesCalls).toBe(0);
    expect(listAllWorktreesCalls).toBe(0);
    expect(listConnectionsCalls).toBe(0);
  });

  it("loads session history without catalog Scans when only catalogs is disabled", async () => {
    let listHostInventoriesCalls = 0;
    const state = createControlPlaneState({
      storage: {
        listAllSessions: async () => [{ id: "session", status: "queued" }],
        listAllWorktrees: async () => [{ id: "wt" }],
        listConnections: async () => [],
        listSchedules: async () => [],
        listRepositories: async () => [],
        listHostInventories: async () => {
          listHostInventoriesCalls += 1;
          return [];
        },
        listProviders: async () => [],
        listProviderAccounts: async () => [],
        listCommands: async () => [],
        listArchives: async () => [],
      } as never,
    });
    await hydrateFromStorage(state, { catalogs: false });
    expect(listHostInventoriesCalls).toBe(0);
    expect(state.sessions.has("session")).toBe(true);
    expect(state.worktrees.size).toBe(0);
  });
});
