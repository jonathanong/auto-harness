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
    const state = createControlPlaneState({
      storage: {
        getSession: async () => null,
        listAllSessions: async () => [],
        listSessionsByStatus: async () => [],
        listLogs: async () => [],
        listAllWorktrees: async () => [worktree],
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
            commandProfiles: [],
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
    await expect(listWorktreesForRepositoryDurable(state, "repository")).resolves.toEqual([
      worktree,
    ]);
    await refreshSchedulerReadModel(state);
    expect(state.hostConnection.get("host")).toBe("connection");
    expect(state.drainingHosts).toEqual(new Set(["host"]));
    expect(state.disconnectedHosts).toEqual(new Map([["host", { lastHeartbeatAt: "t" }]]));
  });
});
