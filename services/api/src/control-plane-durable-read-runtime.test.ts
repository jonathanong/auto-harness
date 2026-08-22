import { describe, expect, it } from "vitest";

import {
  getLogsDurable,
  getSessionDurable,
  listQueuedSessionsDurable,
  listSessionsDurable,
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
    await expect(listQueuedSessionsDurable(state, "prompt")).resolves.toEqual([session]);
    await expect(getLogsDurable(state, session.id)).resolves.toHaveLength(1);
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
});
