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

  it("requests reassignment immediately after a keepalive-driven requeue", async () => {
    const state = createControlPlaneState({ now: () => NOW });
    seedConnectedHost(state);
    const session = { id: "s", hostId: "h", worktreeId: "w", status: "running", attemptId: "a" };
    const worktree = {
      id: "w",
      hostId: "h",
      status: "busy",
      currentSessionId: "s",
    };
    let sweptQueue = 0;
    state.storage = {
      getHostLock: async () => "c",
      heartbeatConnection: async () => true,
      listWorktreesByHost: async () => [worktree],
      getSession: async () => session,
      tryRequeueSession: async () => true,
      listSessionsByStatusPage: async () => {
        sweptQueue += 1;
        return [];
      },
      listConnections: async () => [],
      listHostInventories: async () => [],
    } as never;

    await expect(
      handleHostMessageDurable(
        state,
        { type: "host:keepalive", hostId: "h", at: NOW, runningSessions: [] },
        "c",
      ),
    ).resolves.toEqual({ ok: true });

    // Otherwise the recovered session sits queued until the next cron sweep
    // instead of being redispatched as soon as reconciliation frees it.
    expect(sweptQueue).toBeGreaterThan(0);
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
});
