/* eslint-disable max-lines -- durable disconnect and cold-Lambda retry cases share one control-plane fixture. */
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_SLACK_NOTIFICATIONS } from "@auto-harness/shared";

import { disconnectHostDurable } from "./control-plane-agents.ts";
import { ControlPlane } from "./control-plane.ts";
import { setDurableReadStorage } from "./control-plane-durable-read-test-helpers.ts";
import { reclaimStaleHostsDurable } from "./control-plane-lifecycle.ts";
import { createControlPlaneState } from "./control-plane-state.ts";
import { seedBaseCommand } from "./control-plane-test-helpers.ts";

describe("durable host disconnect", () => {
  it("retains a disconnected host until its offline alert is durably enqueued", async () => {
    const enqueue = vi.fn(async () => "created" as const);
    enqueue.mockRejectedValueOnce(new Error("outbox unavailable"));
    const state = createControlPlaneState({
      heartbeatStaleMs: 1,
      now: () => "2026-01-01T00:00:00.000Z",
      storage: {
        enqueue,
        getSlackIntegration: async () => ({
          id: "slack",
          type: "slack",
          encryptedConfig: "x",
          defaultChannel: "#ops",
          enabled: true,
          notifications: DEFAULT_SLACK_NOTIFICATIONS,
          signingSecretConfigured: false,
          version: 1,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
      } as never,
    });
    state.disconnectedHosts.set("offline", { lastHeartbeatAt: "2000-01-01T00:00:00.000Z" });

    await expect(
      reclaimStaleHostsDurable(state, Date.parse("2026-01-01T00:00:00.000Z")),
    ).resolves.toEqual([]);
    expect(state.disconnectedHosts.has("offline")).toBe(true);

    await expect(
      reclaimStaleHostsDurable(state, Date.parse("2026-01-01T00:00:00.000Z")),
    ).resolves.toEqual([]);
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(state.disconnectedHosts.has("offline")).toBe(false);
  });

  it("persists a local stale candidate before retrying an unavailable outbox", async () => {
    const candidates = new Map<
      string,
      { hostId: string; reason: string; lastHeartbeatAt: string }
    >();
    let canPersist = false;
    const state = createControlPlaneState({ heartbeatStaleMs: 1 });
    setDurableReadStorage(state, {
      recordHostOfflineAlertCandidate: async (candidate: {
        hostId: string;
        reason: string;
        lastHeartbeatAt: string;
      }) => {
        if (!canPersist) throw new Error("host-lock write unavailable");
        candidates.set(candidate.hostId, candidate);
        return true;
      },
      clearHostOfflineAlertCandidate: async (candidate: {
        hostId: string;
        reason: string;
        lastHeartbeatAt: string;
      }) => {
        const current = candidates.get(candidate.hostId);
        if (
          current?.reason !== candidate.reason ||
          current.lastHeartbeatAt !== candidate.lastHeartbeatAt
        ) {
          return false;
        }
        candidates.delete(candidate.hostId);
        return true;
      },
      listHostOfflineAlertCandidates: async () => [],
      getSlackIntegration: async () => ({
        id: "slack",
        type: "slack" as const,
        encryptedConfig: "x",
        defaultChannel: "#ops",
        enabled: true,
        notifications: DEFAULT_SLACK_NOTIFICATIONS,
        signingSecretConfigured: false,
        version: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
      enqueue: async () => "created" as const,
    });
    state.disconnectedHosts.set("offline", { lastHeartbeatAt: "2000-01-01T00:00:00.000Z" });

    await expect(reclaimStaleHostsDurable(state, Date.now())).resolves.toEqual([]);
    expect(candidates.size).toBe(0);
    expect(state.disconnectedHosts.has("offline")).toBe(true);

    canPersist = true;
    await expect(reclaimStaleHostsDurable(state, Date.now())).resolves.toEqual([]);
    expect(candidates.size).toBe(0);
    expect(state.disconnectedHosts.has("offline")).toBe(false);
  });

  it("writes a stale live lease's retry candidate before clearing it after enqueue", async () => {
    const candidates = new Map<
      string,
      { hostId: string; reason: string; lastHeartbeatAt: string }
    >();
    const released: Array<{ hostId: string; connectionId: string }> = [];
    const state = createControlPlaneState({ heartbeatStaleMs: 1 });
    setDurableReadStorage(state, {
      listWorktreesByHost: async () => [],
      releaseHostConnection: async (
        hostId: string,
        connectionId: string,
        candidate?: { reason: string; lastHeartbeatAt: string },
      ) => {
        released.push({ hostId, connectionId });
        if (candidate) candidates.set(hostId, { hostId, ...candidate });
        return true;
      },
      recordHostOfflineAlertCandidate: async (candidate: {
        hostId: string;
        reason: string;
        lastHeartbeatAt: string;
      }) => (candidates.set(candidate.hostId, candidate), true),
      clearHostOfflineAlertCandidate: async (candidate: {
        hostId: string;
        reason: string;
        lastHeartbeatAt: string;
      }) => {
        const current = candidates.get(candidate.hostId);
        if (
          current?.reason !== candidate.reason ||
          current.lastHeartbeatAt !== candidate.lastHeartbeatAt
        ) {
          return false;
        }
        candidates.delete(candidate.hostId);
        return true;
      },
      listHostOfflineAlertCandidates: async () => [],
      getSlackIntegration: async () => ({
        id: "slack",
        type: "slack" as const,
        encryptedConfig: "x",
        defaultChannel: "#ops",
        enabled: true,
        notifications: DEFAULT_SLACK_NOTIFICATIONS,
        signingSecretConfigured: false,
        version: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
      enqueue: async () => "created" as const,
    });
    state.connections.set("connection-1", {
      connectionId: "connection-1",
      type: "host",
      hostId: "offline",
      connectedAt: "2000-01-01T00:00:00.000Z",
      lastHeartbeatAt: "2000-01-01T00:00:00.000Z",
      commandProfiles: [],
    });
    state.hostConnection.set("offline", "connection-1");

    await expect(reclaimStaleHostsDurable(state, Date.now())).resolves.toEqual([]);
    expect(released).toEqual([{ hostId: "offline", connectionId: "connection-1" }]);
    expect(candidates.size).toBe(0);
    expect(state.disconnectedHosts.has("offline")).toBe(false);
  });

  it("retries a lease-release alert from fresh WS and cron Lambda state", async () => {
    const candidates = new Map<
      string,
      { hostId: string; reason: string; lastHeartbeatAt: string }
    >();
    let outboxAvailable = false;
    const storage = {
      getHostLock: async () => "connection-1",
      listWorktreesByHost: async () => [],
      releaseHostConnection: async (
        hostId: string,
        _connectionId: string,
        candidate?: { reason: string; lastHeartbeatAt: string },
      ) => {
        if (candidate) candidates.set(hostId, { hostId, ...candidate });
        return true;
      },
      deleteConnection: async () => undefined,
      recordHostOfflineAlertCandidate: async (candidate: {
        hostId: string;
        reason: string;
        lastHeartbeatAt: string;
      }) => (candidates.set(candidate.hostId, candidate), true),
      clearHostOfflineAlertCandidate: async (candidate: {
        hostId: string;
        reason: string;
        lastHeartbeatAt: string;
      }) => {
        const current = candidates.get(candidate.hostId);
        if (
          current?.reason !== candidate.reason ||
          current.lastHeartbeatAt !== candidate.lastHeartbeatAt
        ) {
          return false;
        }
        candidates.delete(candidate.hostId);
        return true;
      },
      listHostOfflineAlertCandidates: async () => [...candidates.values()],
      getSlackIntegration: async () => ({
        id: "slack",
        type: "slack" as const,
        encryptedConfig: "x",
        defaultChannel: "#ops",
        enabled: true,
        notifications: DEFAULT_SLACK_NOTIFICATIONS,
        signingSecretConfigured: false,
        version: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
      enqueue: async () => {
        if (!outboxAvailable) throw new Error("outbox unavailable");
        return "created" as const;
      },
    };
    const wsState = createControlPlaneState({ storage: storage as never });
    wsState.connections.set("connection-1", {
      connectionId: "connection-1",
      type: "host",
      hostId: "offline",
      connectedAt: "2026-01-01T00:00:00.000Z",
      lastHeartbeatAt: "2026-01-01T00:00:01.000Z",
      commandProfiles: [],
    });
    wsState.hostConnection.set("offline", "connection-1");

    await expect(disconnectHostDurable(wsState, "connection-1")).resolves.toEqual([]);
    expect(candidates.get("offline")).toEqual({
      hostId: "offline",
      reason: "agent disconnected; requeued",
      lastHeartbeatAt: "2026-01-01T00:00:01.000Z",
    });

    const failedCronState = createControlPlaneState({
      heartbeatStaleMs: 1,
      storage: storage as never,
    });
    await expect(reclaimStaleHostsDurable(failedCronState, Date.now())).resolves.toEqual([]);
    expect(candidates.has("offline")).toBe(true);

    outboxAvailable = true;
    const recoveredCronState = createControlPlaneState({
      heartbeatStaleMs: 1,
      storage: storage as never,
    });
    await expect(reclaimStaleHostsDurable(recoveredCronState, Date.now())).resolves.toEqual([]);
    expect(candidates.has("offline")).toBe(false);
  });

  it("drops a warm-memory candidate when a fresh registration already cleared it", async () => {
    const candidate = {
      hostId: "online-again",
      reason: "agent disconnected; requeued",
      lastHeartbeatAt: "2000-01-01T00:00:00.000Z",
    };
    const state = createControlPlaneState({ heartbeatStaleMs: 1 });
    setDurableReadStorage(state, {
      recordHostOfflineAlertCandidate: async () => false,
      clearHostOfflineAlertCandidate: async () => false,
      listHostOfflineAlertCandidates: async () => [candidate],
      getSlackIntegration: async () => ({
        id: "slack",
        type: "slack" as const,
        encryptedConfig: "x",
        defaultChannel: "#ops",
        enabled: true,
        notifications: DEFAULT_SLACK_NOTIFICATIONS,
        signingSecretConfigured: false,
        version: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
      enqueue: async () => "created" as const,
    });
    state.disconnectedHosts.set(candidate.hostId, {
      lastHeartbeatAt: candidate.lastHeartbeatAt,
    });

    await expect(reclaimStaleHostsDurable(state, Date.now())).resolves.toEqual([]);
    expect(state.disconnectedHosts.has(candidate.hostId)).toBe(false);
  });

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
      protocolVersion: 1,
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
