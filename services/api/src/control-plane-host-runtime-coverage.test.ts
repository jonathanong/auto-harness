import { describe, expect, it } from "vitest";

import { drainHostDurable } from "./control-plane-agents.ts";
import { offlineHostAndRequeue } from "./control-plane-worktrees.ts";
import { ControlPlane } from "./control-plane.ts";

const runningMain = {
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
  status: "running" as const,
  queueShard: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  hostId: "host",
  worktreeId: null,
  ackReceivedAt: "2026-01-01T00:00:01.000Z",
  assignmentConnectionId: "connection",
  mainCheckoutLease: true,
  type: "scheduled" as const,
  source: "schedule" as const,
};

const worktree = {
  id: "worktree",
  name: "worktree",
  hostId: "host",
  repositoryId: "repository",
  path: "/repo/worktree",
  labels: [],
  status: "busy" as const,
  online: true,
  currentSessionId: "session",
};

describe("host management runtime coverage", () => {
  it("accepts a durable main-checkout owner with its exact lease", async () => {
    const plane = new ControlPlane({ connectionIdFactory: () => "connection" });
    plane.state.storage = {
      getSession: async () => runningMain,
      getMainCheckoutLease: async () => ({
        hostId: "host",
        repositoryId: "repository",
        sessionId: "session",
        connectionId: "connection",
        acquiredAt: "t",
      }),
      tryRegisterHost: async () => false,
    } as never;

    await expect(
      plane.registerHostDurable({
        hostId: "host",
        worktrees: [],
        commandProfiles: [],
        runningSessions: ["session"],
      }),
    ).resolves.toEqual({ ok: false, error: "hostId host already has an active connection" });
  });

  it("rejects a main-checkout session owned by another connection", async () => {
    const plane = new ControlPlane();
    plane.state.storage = {
      getSession: async () => runningMain,
      getMainCheckoutLease: async () => ({
        hostId: "host",
        repositoryId: "repository",
        sessionId: "session",
        connectionId: "replacement",
        acquiredAt: "t",
      }),
    } as never;

    await expect(
      plane.registerHostDurable({
        hostId: "host",
        worktrees: [],
        commandProfiles: [],
        runningSessions: ["session"],
      }),
    ).resolves.toEqual({ ok: false, error: "running session session is not owned by host host" });
  });

  it("uses a non-replacing lock for the first queued registration", async () => {
    const attempts: boolean[] = [];
    const plane = new ControlPlane({ connectionIdFactory: () => "connection" });
    plane.state.storage = {
      tryAcquireHostLock: async ({ replaceExisting }: { replaceExisting: boolean }) => {
        attempts.push(replaceExisting);
        return true;
      },
      putConnection: async () => undefined,
      putHostInventory: async () => undefined,
      listWorktreesByHost: async () => [],
    } as never;

    expect(plane.registerHost({ hostId: "host", worktrees: [], commandProfiles: [] })).toEqual({
      ok: true,
      connectionId: "connection",
    });
    await plane.settleStorage();
    expect(attempts).toEqual([false]);
  });

  it("delivers the durable drain notification when a listener is configured", async () => {
    const messages: unknown[] = [];
    const plane = new ControlPlane({ onHostMessage: (_hostId, message) => messages.push(message) });
    plane.state.storage = {
      getHostLock: async () => "owner",
      markHostDraining: async () => true,
    } as never;

    await expect(drainHostDurable(plane.state, "host")).resolves.toEqual({
      ok: true,
      runningSessionIds: [],
    });
    expect(messages).toEqual([{ type: "host:drain" }]);
  });

  it("requeues an unacknowledged busy worktree assignment", () => {
    const plane = new ControlPlane({ now: () => "2026-01-01T00:00:00.000Z" });
    plane.state.worktrees.set("worktree", { ...worktree });
    plane.state.sessions.set("session", {
      ...runningMain,
      mainCheckoutLease: undefined,
      worktreeId: "worktree",
      ackReceivedAt: undefined,
    });
    plane.state.pendingAcks.set("session", {
      sessionId: "session",
      hostId: "host",
      worktreeId: "worktree",
      connectionId: "connection",
      deadlineAt: "later",
    });

    expect(offlineHostAndRequeue(plane.state, "host", "disconnected")).toEqual(["session"]);
    expect(plane.getSession("session")).toMatchObject({
      status: "queued",
      hostId: null,
      worktreeId: null,
      errorMessage: "disconnected",
    });
    expect(plane.state.pendingAcks.has("session")).toBe(false);
  });

  it("normalizes a primitive clock failure while preparing host inventory", () => {
    const plane = new ControlPlane({
      now: () => {
        throw "clock unavailable";
      },
    });
    expect(plane.putHostInventory("host", { repositories: [], commandProfiles: {} })).toEqual({
      ok: false,
      error: "clock unavailable",
    });
  });
});
