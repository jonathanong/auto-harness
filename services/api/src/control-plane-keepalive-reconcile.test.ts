import { describe, expect, it } from "vitest";

import { handleHostMessageDurable } from "./control-plane-messages.ts";
import { createControlPlaneState } from "./control-plane-state.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function connectionRecord() {
  return {
    connectionId: "c",
    type: "host" as const,
    hostId: "h",
    connectedAt: NOW,
    lastHeartbeatAt: NOW,
    commandProfiles: [],
    runtime: { daemonVersion: "test", gitVersion: "2.36.0", gitReady: true },
    protocolVersion: 1,
  };
}

function seedConnectedHost(state: ReturnType<typeof createControlPlaneState>): void {
  state.hostConnection.set("h", "c");
  state.connections.set("c", connectionRecord());
}

describe("keepalive-driven session reconciliation", () => {
  it("requeues a session the daemon no longer reports as running", async () => {
    const state = createControlPlaneState({ now: () => NOW });
    seedConnectedHost(state);
    const session = { id: "s", hostId: "h", worktreeId: "w", status: "running", attemptId: "a" };
    const worktree = {
      id: "w",
      hostId: "h",
      status: "busy",
      currentSessionId: "s",
    };
    let requeueOptions: Record<string, unknown> | undefined;
    state.storage = {
      getHostLock: async () => "c",
      heartbeatConnection: async () => true,
      listWorktreesByHost: async () => [worktree],
      getSession: async () => session,
      tryRequeueSession: async (opts: Record<string, unknown>) => {
        requeueOptions = opts;
        return true;
      },
    } as never;

    await expect(
      handleHostMessageDurable(
        state,
        { type: "host:keepalive", hostId: "h", at: NOW, runningSessions: [] },
        "c",
      ),
    ).resolves.toEqual({ ok: true });

    expect(requeueOptions).toMatchObject({
      sessionId: "s",
      reason: "daemon no longer reports session as running; requeued",
    });
  });

  it("leaves a session alone when the keepalive still reports it as running", async () => {
    const state = createControlPlaneState({ now: () => NOW });
    seedConnectedHost(state);
    const session = { id: "s", hostId: "h", worktreeId: "w", status: "running", attemptId: "a" };
    const worktree = {
      id: "w",
      hostId: "h",
      status: "busy",
      currentSessionId: "s",
    };
    let requeued = false;
    state.storage = {
      getHostLock: async () => "c",
      heartbeatConnection: async () => true,
      listWorktreesByHost: async () => [worktree],
      getSession: async () => session,
      tryRequeueSession: async () => {
        requeued = true;
        return true;
      },
    } as never;

    await expect(
      handleHostMessageDurable(
        state,
        { type: "host:keepalive", hostId: "h", at: NOW, runningSessions: ["s"] },
        "c",
      ),
    ).resolves.toEqual({ ok: true });

    expect(requeued).toBe(false);
  });

  it("reconciles a keepalive-omitted session in local (non-durable) mode too", async () => {
    const state = createControlPlaneState({ now: () => NOW });
    state.hostConnection.set("h", "c");
    state.connections.set("c", connectionRecord());
    state.sessions.set("s", {
      id: "s",
      repositoryId: "r",
      prompt: "p",
      target: { commandId: "cmd" },
      fallbacks: [],
      targetDisplayNames: [],
      queueTtlSeconds: 60,
      queueExpiresAt: "2099-01-01T00:00:00.000Z",
      timeout: 1,
      priority: 0,
      requiredLabels: [],
      status: "running",
      queueShard: 0,
      createdAt: NOW,
      hostId: "h",
      worktreeId: "w",
      attemptId: "a",
    });
    state.worktrees.set("w", {
      id: "w",
      name: "w",
      hostId: "h",
      repositoryId: "r",
      path: "/w",
      labels: [],
      status: "busy",
      online: true,
      currentSessionId: "s",
    });

    await expect(
      handleHostMessageDurable(state, {
        type: "host:keepalive",
        hostId: "h",
        at: NOW,
        runningSessions: [],
      }),
    ).resolves.toEqual({ ok: true });

    expect(state.sessions.get("s")?.status).toBe("queued");
  });

  it("requeues a keepalive-omitted scheduled session with the keepalive reason, not the reconnect one", async () => {
    const state = createControlPlaneState({ now: () => NOW });
    seedConnectedHost(state);
    const session = {
      id: "s",
      hostId: "h",
      worktreeId: null,
      status: "running",
      attemptId: "a",
      repositoryId: "r",
      mainCheckoutLease: true,
      assignmentConnectionId: "c",
      queueShard: 0,
    };
    let releaseReason: unknown;
    state.storage = {
      getHostLock: async () => "c",
      heartbeatConnection: async () => true,
      listWorktreesByHost: async () => [],
      listSessionsByHost: async () => [session],
      releaseMainCheckoutSession: async (opts: Record<string, unknown>) => {
        releaseReason = opts.reason;
        return true;
      },
    } as never;

    await expect(
      handleHostMessageDurable(
        state,
        { type: "host:keepalive", hostId: "h", at: NOW, runningSessions: [] },
        "c",
      ),
    ).resolves.toEqual({ ok: true });

    expect(releaseReason).toBe("daemon no longer reports session as running; requeued");
  });

  it("skips reconciliation entirely for a legacy daemon that omits runningSessions", async () => {
    const state = createControlPlaneState({ now: () => NOW });
    seedConnectedHost(state);
    let listed = false;
    state.storage = {
      getHostLock: async () => "c",
      heartbeatConnection: async () => true,
      listWorktreesByHost: async () => {
        listed = true;
        return [];
      },
    } as never;

    await expect(
      handleHostMessageDurable(state, { type: "host:keepalive", hostId: "h", at: NOW }, "c"),
    ).resolves.toEqual({ ok: true });

    expect(listed).toBe(false);
  });
});
