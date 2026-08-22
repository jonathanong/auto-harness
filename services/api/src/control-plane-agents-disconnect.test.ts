import { describe, expect, it } from "vitest";

import { disconnectHostDurable } from "./control-plane-agents.ts";
import { ControlPlane } from "./control-plane.ts";
import { setDurableReadStorage } from "./control-plane-durable-read-test-helpers.ts";
import { reclaimStaleHostsDurable } from "./control-plane-lifecycle.ts";
import { seedBaseCommand } from "./control-plane-test-helpers.ts";

describe("durable host disconnect", () => {
  it("drops stale local connections and reports requeues even when exact release loses", async () => {
    const plane = new ControlPlane({ heartbeatStaleMs: 1 });
    plane.state.hostConnection.set("h", "c");
    plane.state.connections.set("c", {
      connectionId: "c",
      type: "host",
      hostId: "h",
      connectedAt: "old",
      lastHeartbeatAt: "2000-01-01T00:00:00.000Z",
      commandProfiles: [],
    });
    const worktree = {
      id: "w",
      name: "w",
      hostId: "h",
      repositoryId: "r",
      path: "/w",
      labels: [],
      status: "busy" as const,
      online: true,
      currentSessionId: "s",
      connectionId: "c",
    };
    const running = {
      id: "s",
      repositoryId: "r",
      prompt: "p",
      targetLabel: "t",
      timeout: 1,
      priority: 0,
      requiredLabels: [],
      onConflict: "queue" as const,
      status: "running" as const,
      queueShard: 0,
      createdAt: "old",
      hostId: "h",
      worktreeId: "w",
    };
    setDurableReadStorage(plane.state, {
      listWorktreesByHost: async () => [worktree],
      getSession: async () => running,
      tryRequeueSession: async () => true,
      releaseHostConnection: async () => false,
      deleteConnection: async () => undefined,
    });

    expect(await reclaimStaleHostsDurable(plane.state, Date.now())).toEqual(["s"]);
    expect(plane.state.connections.has("c")).toBe(false);
    expect(plane.state.hostConnection.has("h")).toBe(false);

    plane.state.connections.set("stale", {
      connectionId: "stale",
      type: "host",
      hostId: "h",
      connectedAt: "old",
      lastHeartbeatAt: "old",
      commandProfiles: [],
    });
    plane.state.hostConnection.set("h", "stale");
    const deleted: string[] = [];
    plane.state.connections.set("replacement", {
      connectionId: "replacement",
      type: "host",
      hostId: "h",
      connectedAt: "new",
      lastHeartbeatAt: "new",
      commandProfiles: [],
    });
    plane.state.hostConnection.set("h", "replacement");
    plane.state.storage.getHostLock = async () => "replacement";
    plane.state.storage.deleteConnection = async (connectionId: string) => {
      deleted.push(connectionId);
    };
    expect(await disconnectHostDurable(plane.state, "stale")).toEqual([]);
    expect(plane.state.connections.has("stale")).toBe(false);
    expect(deleted).toEqual(["stale"]);
    expect(plane.state.hostConnection.get("h")).toBe("replacement");
  });

  it("keeps a replacement eligible for durable scheduling while deleting a stale connection", async () => {
    const plane = new ControlPlane({ shardCount: 1, now: () => "2026-01-01T00:00:00.000Z" });
    seedBaseCommand(plane);
    plane.state.connections.set("A", {
      connectionId: "A",
      type: "host",
      hostId: "h",
      connectedAt: "old",
      lastHeartbeatAt: "old",
      commandProfiles: ["echo-prompt"],
    });
    plane.state.connections.set("B", {
      connectionId: "B",
      type: "host",
      hostId: "h",
      connectedAt: "new",
      lastHeartbeatAt: "new",
      commandProfiles: ["echo-prompt"],
      runtime: { daemonVersion: "test", gitVersion: "2.36.0", gitReady: true },
    });
    plane.state.hostConnection.set("h", "B");
    plane.state.worktrees.set("w", {
      id: "w",
      name: "w",
      hostId: "h",
      repositoryId: "repo-1",
      path: "/w",
      labels: [],
      status: "idle",
      online: true,
      currentSessionId: null,
      connectionId: "B",
    });
    plane.state.sessions.set("s", {
      id: "s",
      repositoryId: "repo-1",
      prompt: "work",
      target: { commandId: "cmd-base" },
      fallbacks: [],
      targetLabels: ["echo-prompt"],
      queueTtlSeconds: 60,
      queueExpiresAt: "2099-01-01T00:00:00.000Z",
      timeout: 1,
      priority: 0,
      requiredLabels: [],
      onConflict: "queue",
      status: "queued",
      queueShard: 0,
      createdAt: "old",
      type: "prompt",
      source: "api",
    });
    const assigns: Array<Record<string, unknown>> = [];
    setDurableReadStorage(plane.state, {
      getHostLock: async () => "B",
      deleteConnection: async () => undefined,
      listAllSessions: async () => [],
      tryAssignSession: async (opts: Record<string, unknown>) => (assigns.push(opts), true),
    });

    expect(await disconnectHostDurable(plane.state, "A")).toEqual([]);
    expect(plane.state.hostConnection.get("h")).toBe("B");
    expect((await plane.assignQueuedDurable()).map((item) => item.session.id)).toEqual(["s"]);
    expect(assigns).toEqual([expect.objectContaining({ connectionId: "B" })]);
  });
});
