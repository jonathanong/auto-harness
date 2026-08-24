/* eslint-disable max-lines -- durable read paths share one state fixture. */
import { describe, expect, it } from "vitest";

import {
  getLogsDurable,
  getSessionDurable,
  listQueuedSessionsDurable,
  listSessionsDurable,
  listSessionsForRepositoriesDurable,
  listWorktreesDurable,
  listWorktreesForRepositoryDurable,
  refreshSchedulerReadModel,
} from "./control-plane-durable-read-runtime.ts";
import { ControlPlane } from "./control-plane.ts";
import { ControlPlaneBase } from "./control-plane-facade.ts";
import { createControlPlaneState } from "./control-plane-state.ts";

const session = {
  id: "session",
  repositoryId: "repository",
  prompt: "work",
  target: { commandId: "command" },
  fallbacks: [],
  targetLabels: ["command"],
  queueTtlSeconds: 60,
  queueExpiresAt: "2026-01-01T00:01:00.000Z",
  timeout: 1,
  priority: 0,
  requiredLabels: [],
  status: "queued" as const,
  queueShard: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  type: "prompt" as const,
  source: "api" as const,
};
const worktree = {
  id: "worktree",
  name: "worktree",
  hostId: "host",
  repositoryId: "repository",
  path: "/worktree",
  labels: [],
  status: "idle" as const,
  online: true,
};

describe("durable runtime read-through", () => {
  it("keeps the base durable session facade available to subclasses", async () => {
    const plane = new ControlPlaneBase();
    plane.state.sessions.set(session.id, { ...session });

    await expect(plane.getSessionDurable(session.id)).resolves.toMatchObject({ id: session.id });
  });

  it("reads the base durable session facade from storage", async () => {
    const plane = new ControlPlaneBase({
      storage: {
        getSession: async (id: string) => (id === session.id ? { ...session } : null),
      } as never,
    });

    await expect(plane.getSessionDurable(session.id)).resolves.toMatchObject({ id: session.id });
    await expect(plane.getSessionDurable("missing")).resolves.toBeNull();
  });

  it("exposes cache-backed host read facades without storage", async () => {
    const plane = new ControlPlane();
    plane.seedWorktree({ ...worktree, currentSessionId: null, lastAssignedAt: null });
    plane.registerHost({ hostId: "host", worktrees: [] });

    await expect(plane.listWorktreesDurable()).resolves.toHaveLength(1);
    await expect(plane.listHostsDurable()).resolves.toHaveLength(1);
  });

  it("exposes every cache-backed session and schedule read facade", async () => {
    const plane = new ControlPlane({ now: () => "2026-01-01T00:00:00.000Z" });
    plane.createCommand({ id: "command", name: "command", argv: ["echo"] });
    const created = plane.createSession({
      repositoryId: "repository",
      prompt: "work",
      target: { commandId: "command" },
      timeout: 1,
    });
    if (!created.ok) throw new Error(created.error);
    plane.appendLog({
      sessionId: created.session.id,
      stream: "stdout",
      content: "log",
      timestamp: "2026-01-01T00:00:00.000Z",
      seq: 1,
    });
    const schedule = plane.putSchedule({
      repositoryId: "repository",
      name: "schedule",
      target: { commandId: "command" },
      cron: "* * * * *",
      timeout: 1,
    });
    if (!schedule.ok) throw new Error(schedule.error);

    await expect(plane.getSessionDurable(created.session.id)).resolves.toMatchObject({
      id: created.session.id,
    });
    await expect(plane.listSessionsPageDurable()).resolves.toMatchObject({
      items: [{ id: created.session.id }],
    });
    await expect(plane.getLogsDurable(created.session.id)).resolves.toHaveLength(1);
    await expect(plane.getScheduleDurable(schedule.schedule.id)).resolves.toMatchObject({
      id: schedule.schedule.id,
    });
    await expect(plane.listSchedulesDurable()).resolves.toHaveLength(1);
  });

  it("preserves in-memory behavior when storage is absent", async () => {
    const state = createControlPlaneState();
    state.sessions.set(session.id, { ...session });
    state.worktrees.set(worktree.id, { ...worktree });
    state.logs.set(session.id, [
      {
        sessionId: session.id,
        timestampSeq: "2",
        stream: "stdout",
        content: "second",
        timestamp: "t",
        seq: 2,
      },
    ]);

    await expect(getSessionDurable(state, session.id)).resolves.toEqual(session);
    await expect(getSessionDurable(state, "missing")).resolves.toBeNull();
    await expect(listSessionsDurable(state)).resolves.toEqual([session]);
    await expect(listSessionsForRepositoriesDurable(state, ["repository"])).resolves.toEqual([
      session,
    ]);
    await expect(listQueuedSessionsDurable(state, "prompt")).resolves.toEqual([session]);
    await expect(getLogsDurable(state, session.id)).resolves.toHaveLength(1);
    await expect(getLogsDurable(state, "missing")).resolves.toEqual([]);
    await expect(listWorktreesDurable(state)).resolves.toEqual([worktree]);
    await expect(listWorktreesForRepositoryDurable(state, "repository")).resolves.toEqual([
      worktree,
    ]);
    await expect(refreshSchedulerReadModel(state)).resolves.toBeUndefined();
  });

  it("replaces stale runtime rows from targeted durable reads", async () => {
    const worktreeReadModes: boolean[] = [];
    const state = createControlPlaneState({
      storage: {
        getSession: async () => null,
        listAllSessions: async () => [],
        listSessionsByStatus: async () => [],
        listLogs: async () => [],
        listAllWorktrees: async (consistentRead = false) => {
          worktreeReadModes.push(consistentRead);
          return [worktree];
        },
        listWorktreesForRepo: async () => [worktree],
        listCommands: async () => [],
        listProviders: async () => [],
        listProviderAccounts: async () => [],
        listRepositories: async () => [],
        listHostInventories: async () => [],
        listConnections: async () => [
          {
            connectionId: "connection",
            type: "host",
            hostId: "host",
            connectedAt: "t",
            lastHeartbeatAt: "t",
          },
        ],
      } as never,
    });
    state.sessions.set(session.id, { ...session });
    state.worktrees.set(worktree.id, { ...worktree });
    state.drainingHosts.add("host");
    state.disconnectedHosts.set("host", { lastHeartbeatAt: "t" });

    await expect(getSessionDurable(state, session.id)).resolves.toBeNull();
    await expect(listSessionsDurable(state)).resolves.toEqual([]);
    await expect(listQueuedSessionsDurable(state, "prompt")).resolves.toEqual([]);
    await expect(getLogsDurable(state, session.id)).resolves.toEqual([]);
    await expect(listWorktreesDurable(state)).resolves.toEqual([worktree]);
    expect(worktreeReadModes).toEqual([true]);
    await expect(listWorktreesForRepositoryDurable(state, "repository")).resolves.toEqual([
      worktree,
    ]);
    await refreshSchedulerReadModel(state);
    expect(state.hostConnection.get("host")).toBe("connection");
    expect(state.drainingHosts).toEqual(new Set(["host"]));
    expect(state.disconnectedHosts).toEqual(new Map([["host", { lastHeartbeatAt: "t" }]]));
  });

  it("refreshes drain state from the durable host lock", async () => {
    const state = createControlPlaneState({
      storage: {
        listConnections: async () => [
          {
            connectionId: "connection",
            type: "host",
            hostId: "host",
            connectedAt: "t",
            lastHeartbeatAt: "t",
          },
        ],
        listHostInventories: async () => [],
        listWorktrees: async () => [],
        listAllWorktrees: async () => [],
        listRepositories: async () => [],
        listSchedules: async () => [],
        listCommands: async () => [],
        listProviders: async () => [],
        listProviderAccounts: async () => [],
        getHostLockState: async () => ({ connectionId: "connection", draining: true }),
      } as never,
    });

    await refreshSchedulerReadModel(state);
    expect(state.drainingHosts).toEqual(new Set(["host"]));
  });

  it("hydrates running occupancy so advertised host assignment caps apply", async () => {
    const running = {
      ...session,
      id: "running",
      status: "running" as const,
      hostId: "host",
    };
    const state = createControlPlaneState({
      shardCount: 1,
      storage: {
        listConnections: async () => [
          {
            connectionId: "connection",
            type: "host",
            hostId: "host",
            connectedAt: "t",
            lastHeartbeatAt: "t",
            maxConcurrentAssignments: 1,
          },
        ],
        listHostInventories: async () => [],
        listRepositories: async () => [],
        listCommands: async () => [],
        listProviders: async () => [],
        listProviderAccounts: async () => [],
        getSession: async (id: string) => (id === "running" ? { ...running } : null),
        listSessionsByStatus: async (status: string) => (status === "running" ? [running] : []),
      } as never,
    });
    state.sessions.set(session.id, { ...session, status: "running", hostId: "stale" });

    await refreshSchedulerReadModel(state);
    expect(state.sessions.get("running")).toMatchObject({ status: "running", hostId: "host" });
    expect(state.sessions.has(session.id)).toBe(false);
  });

  it("keeps in-memory queued sessions when the status GSI has not caught up", async () => {
    const state = createControlPlaneState({
      shardCount: 1,
      storage: { listSessionsByStatus: async () => [] } as never,
    });
    state.sessions.set(session.id, { ...session });

    await expect(listQueuedSessionsDurable(state, "prompt")).resolves.toEqual([session]);
    expect(state.sessions.get(session.id)).toEqual(session);
  });

  it("does not revert a just-assigned session when the queued GSI still lists it", async () => {
    const assigned = {
      ...session,
      status: "running" as const,
      hostId: "host",
      worktreeId: "worktree",
    };
    const state = createControlPlaneState({
      shardCount: 1,
      storage: { listSessionsByStatus: async () => [{ ...session }] } as never,
    });
    state.sessions.set(session.id, assigned);

    await expect(listQueuedSessionsDurable(state, "prompt")).resolves.toEqual([]);
    expect(state.sessions.get(session.id)).toEqual(assigned);
  });

  it("keeps just-written occupancy when the status GSI lags", async () => {
    const running = {
      ...session,
      status: "running" as const,
      hostId: "host",
      worktreeId: "worktree",
    };
    const state = createControlPlaneState({
      shardCount: 1,
      storage: {
        listConnections: async () => [
          {
            connectionId: "connection",
            type: "host",
            hostId: "host",
            connectedAt: "t",
            lastHeartbeatAt: "t",
            maxConcurrentAssignments: 1,
          },
        ],
        listHostInventories: async () => [],
        listRepositories: async () => [],
        listCommands: async () => [],
        listProviders: async () => [],
        listProviderAccounts: async () => [],
        listSessionsByStatus: async () => [],
        getSession: async (id: string) => (id === running.id ? { ...running } : null),
      } as never,
    });
    state.sessions.set(running.id, running);

    await refreshSchedulerReadModel(state);
    expect(state.sessions.get(running.id)).toMatchObject({
      status: "running",
      hostId: "host",
      worktreeId: "worktree",
    });
  });

  it("keeps local occupancy when storage cannot re-read the session", async () => {
    const running = {
      ...session,
      status: "running" as const,
      hostId: "host",
      worktreeId: "worktree",
    };
    const state = createControlPlaneState({
      shardCount: 1,
      storage: {
        listConnections: async () => [],
        listHostInventories: async () => [],
        listRepositories: async () => [],
        listCommands: async () => [],
        listProviders: async () => [],
        listProviderAccounts: async () => [],
        listSessionsByStatus: async () => [],
      } as never,
    });
    state.sessions.set(running.id, running);

    await refreshSchedulerReadModel(state);
    expect(state.sessions.get(running.id)).toMatchObject({ status: "running", hostId: "host" });
  });

  it("hydrates cancelled occupancy so in-flight cancels still consume host caps", async () => {
    const occupying = {
      ...session,
      id: "cancelled-hold",
      status: "cancelled" as const,
      hostId: "host",
      worktreeId: "worktree",
    };
    const released = {
      ...session,
      id: "cancelled-released",
      status: "cancelled" as const,
      hostId: "host",
    };
    const state = createControlPlaneState({
      shardCount: 1,
      storage: {
        listConnections: async () => [
          {
            connectionId: "connection",
            type: "host",
            hostId: "host",
            connectedAt: "t",
            lastHeartbeatAt: "t",
            maxConcurrentAssignments: 1,
          },
        ],
        listHostInventories: async () => [],
        listRepositories: async () => [],
        listCommands: async () => [],
        listProviders: async () => [],
        listProviderAccounts: async () => [],
        getSession: async (id: string) => (id === occupying.id ? { ...occupying } : null),
        listSessionsByStatus: async (status: string) =>
          status === "cancelled" ? [occupying, released] : [],
      } as never,
    });
    state.sessions.set("stale-cancelled", {
      ...occupying,
      id: "stale-cancelled",
      worktreeId: "stale",
    });

    await refreshSchedulerReadModel(state);
    expect(state.sessions.get("cancelled-hold")).toMatchObject({
      status: "cancelled",
      worktreeId: "worktree",
    });
    expect(state.sessions.has("cancelled-released")).toBe(false);
    expect(state.sessions.has("stale-cancelled")).toBe(false);
  });

  it("reads repository pages and skips pending durable connections", async () => {
    const state = createControlPlaneState({
      storage: {
        listSessionsByRepository: async () => [session],
        listConnections: async () => [
          {
            connectionId: "pending",
            type: "host",
            hostId: "host",
            connectedAt: "t",
            lastHeartbeatAt: "t",
            registered: false,
          },
        ],
        listHostInventories: async () => [],
        listWorktrees: async () => [],
        listAllWorktrees: async () => [],
        listRepositories: async () => [],
        listSchedules: async () => [],
        listCommands: async () => [],
        listProviders: async () => [],
        listProviderAccounts: async () => [],
      } as never,
    });
    await expect(listSessionsForRepositoriesDurable(state, ["repository"])).resolves.toEqual([
      session,
    ]);
    await refreshSchedulerReadModel(state);
    expect(state.connections.size).toBe(0);
  });

  it("handles repository-only page scopes and absent durable counts", async () => {
    const plane = new ControlPlane({
      storage: {
        countSessionsByRepository: async () => undefined,
        listAllWorktrees: async () => [],
        listSchedules: async () => [],
        listSessionsByRepository: async () => [session],
      } as never,
    });
    await expect(plane.listRepositoryCountsDurable(["repository"])).resolves.toEqual(
      new Map([["repository", { sessionCount: 0, worktreeCount: 0, scheduleCount: 0 }]]),
    );
    await expect(
      plane.listSessionsPageDurable({ repositoryId: "repository" }),
    ).resolves.toMatchObject({ items: [{ id: "session" }] });
    await expect(
      plane.listSessionsPageDurable({
        repositoryId: "repository",
        scope: { repositoryIds: ["elsewhere"] },
      }),
    ).resolves.toMatchObject({ items: [] });
    await expect(
      plane.listSessionsPageDurable({
        repositoryId: "repository",
        scope: { repositoryIds: ["repository"] },
      }),
    ).resolves.toMatchObject({ items: [{ id: "session" }] });
    await expect(plane.listRepositoryCountsDurable([])).resolves.toEqual(new Map());
  });

  it("uses repository indexes for page counts instead of catalog scans", async () => {
    const worktreeCalls: Array<[string, string | undefined]> = [];
    const scheduleCalls: string[] = [];
    const plane = new ControlPlane({
      storage: {
        countSessionsByRepository: async () => 2,
        countWorktreesByRepository: async (repositoryId: string, hostId?: string) => {
          worktreeCalls.push([repositoryId, hostId]);
          return 3;
        },
        countSchedulesByRepository: async (repositoryId: string) => {
          scheduleCalls.push(repositoryId);
          return 4;
        },
        listAllWorktrees: async () => {
          throw new Error("unexpected worktree scan");
        },
        listSchedules: async () => {
          throw new Error("unexpected schedule scan");
        },
      } as never,
    });

    await expect(plane.listRepositoryCountsDurable(["repository"], "host")).resolves.toEqual(
      new Map([["repository", { sessionCount: 2, worktreeCount: 3, scheduleCount: 4 }]]),
    );
    expect(worktreeCalls).toEqual([["repository", "host"]]);
    expect(scheduleCalls).toEqual(["repository"]);
  });

  it("uses one strong scan while repository count indexes are backfilling", async () => {
    const unavailable = Object.assign(
      new Error("Cannot read from backfilling global secondary index"),
      { name: "ValidationException" },
    );
    const plane = new ControlPlane({
      storage: {
        countSessionsByRepository: async () => {
          throw unavailable;
        },
        countWorktreesByRepository: async () => {
          throw unavailable;
        },
        countSchedulesByRepository: async () => {
          throw unavailable;
        },
        listAllWorktrees: async () => [worktree, { ...worktree, id: "other", hostId: "other" }],
        listAllSessions: async () => [
          { ...session, hostId: "host" },
          { ...session, id: "other", repositoryId: "other", hostId: "host" },
        ],
        listSchedules: async () => [{ id: "schedule", repositoryId: "repository" }],
      } as never,
    });

    await expect(plane.listRepositoryCountsDurable(["repository"], "host")).resolves.toEqual(
      new Map([["repository", { sessionCount: 1, worktreeCount: 1, scheduleCount: 1 }]]),
    );
  });

  it("does not hide unrelated session-count failures", async () => {
    const plane = new ControlPlane({
      storage: {
        countSessionsByRepository: async () => {
          throw new Error("session query unavailable");
        },
        countWorktreesByRepository: async () => 0,
        countSchedulesByRepository: async () => 0,
      } as never,
    });

    await expect(plane.listRepositoryCountsDurable(["repository"])).rejects.toThrow(
      "session query unavailable",
    );
  });

  it("does not hide unrelated indexed-count failures", async () => {
    const plane = new ControlPlane({
      storage: {
        countSessionsByRepository: async () => 0,
        countWorktreesByRepository: async () => {
          throw new Error("credentials expired");
        },
        countSchedulesByRepository: async () => 0,
      } as never,
    });

    await expect(plane.listRepositoryCountsDurable(["repository"])).rejects.toThrow(
      "credentials expired",
    );
  });

  it("does not hide unrelated schedule-count failures", async () => {
    const plane = new ControlPlane({
      storage: {
        countSessionsByRepository: async () => 0,
        countWorktreesByRepository: async () => 0,
        countSchedulesByRepository: async () => {
          throw new Error("schedule table unavailable");
        },
      } as never,
    });

    await expect(plane.listRepositoryCountsDurable(["repository"])).rejects.toThrow(
      "schedule table unavailable",
    );
  });
});
