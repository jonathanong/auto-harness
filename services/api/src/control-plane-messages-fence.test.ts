/* eslint-disable max-lines */
import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";

function running(id = "s") {
  return {
    id,
    repositoryId: "r",
    prompt: "p",
    target: { commandId: "cmd" },
    fallbacks: [],
    targetLabels: [],
    queueTtlSeconds: 60,
    queueExpiresAt: "2099-01-01T00:00:00.000Z",
    targetLabel: "t",
    timeout: 1,
    priority: 0,
    requiredLabels: [],
    concurrencyId: "session-lock",
    status: "running" as const,
    queueShard: 0,
    createdAt: "t",
    hostId: "h",
    worktreeId: "w",
    attemptId: "a",
  };
}

describe("durable host-message fencing", () => {
  it("confirms only an accepted in-memory ACK transition", () => {
    const deliveries: Array<{ hostId: string; message: unknown }> = [];
    const plane = new ControlPlane({
      now: () => "now",
      onHostMessage: (hostId, message) => deliveries.push({ hostId, message }),
    });
    plane.state.sessions.set("s", running());
    plane.state.sessions.set("done", { ...running("done"), status: "completed" });

    const frame = { type: "session:ack" as const, sessionId: "s", worktreeId: "w", attemptId: "a" };
    expect(plane.handleHostMessage(frame)).toEqual({ ok: true });
    expect(deliveries).toEqual([
      {
        hostId: "h",
        message: { type: "session:acknowledged", sessionId: "s" },
      },
    ]);

    // Duplicate and rejected frames are idempotent or rejected, never a new
    // execution permission for the daemon.
    expect(plane.handleHostMessage(frame)).toEqual({ ok: true });
    expect(plane.handleHostMessage({ ...frame, sessionId: "done" })).toEqual({
      ok: true,
    });
    expect(plane.handleHostMessage({ ...frame, sessionId: "missing" })).toEqual({
      ok: false,
      error: "session not found",
    });
    expect(deliveries).toHaveLength(1);
  });

  it("rejects stale sources and preserves unfenced compatibility paths", async () => {
    const plane = new ControlPlane({ now: () => "now" });
    plane.state.sessions.set("s", running());
    plane.state.storage = {
      getSession: async () => running(),
      getHostLock: async () => "current",
      acknowledgeSession: async () => true,
      heartbeatConnection: async () => false,
      finishSession: async () => false,
    } as never;
    expect(
      await plane.handleHostMessageDurable(
        { type: "session:ack", sessionId: "s", worktreeId: "w", attemptId: "a" },
        "stale",
      ),
    ).toEqual({ ok: false, error: "stale host connection" });
    expect(
      await plane.handleHostMessageDurable({
        type: "session:ack",
        sessionId: "s",
        worktreeId: "w",
        attemptId: "a",
      }),
    ).toEqual({
      ok: true,
      sessionAcknowledged: "s",
    });
    expect(
      await plane.handleHostMessageDurable({ type: "host:keepalive", hostId: "h", at: "later" }),
    ).toEqual({ ok: false, error: "agent not connected" });
    expect(
      await plane.handleHostMessageDurable({
        type: "session:status",
        sessionId: "s",
        worktreeId: "w",
        attemptId: "a",
        status: "running",
      }),
    ).toEqual({ ok: true });
  });

  it("fences logs and terminal statuses to the current connection", async () => {
    const plane = new ControlPlane({ now: () => "now" });
    plane.state.sessions.set("s", running());
    plane.state.worktrees.set("w", {
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
    let logFence = false;
    let statusFence = false;
    let statusConcurrencyId: string | undefined;
    plane.state.storage = {
      getSession: async () => running(),
      getHostLock: async () => "c",
      putLogFenced: async () => false,
      finishSession: async (opts: { fence?: unknown; concurrencyId?: string }) => {
        statusFence = opts.fence !== undefined;
        statusConcurrencyId = opts.concurrencyId;
        return true;
      },
      putArchive: async () => {},
    } as never;
    expect(
      await plane.handleHostMessageDurable(
        {
          type: "session:log",
          sessionId: "s",
          stream: "stdout",
          content: "x",
          timestamp: "t",
          seq: 1,
        },
        "c",
      ),
    ).toEqual({ ok: false, error: "stale host connection" });
    plane.state.storage.putLogFenced = async () => {
      logFence = true;
      return true;
    };
    expect(
      await plane.handleHostMessageDurable(
        {
          type: "session:status",
          sessionId: "s",
          worktreeId: "w",
          attemptId: "a",
          status: "completed",
        },
        "c",
      ),
    ).toEqual({ ok: true });
    expect(logFence).toBe(false);
    expect(statusFence).toBe(true);
    expect(statusConcurrencyId).toBe("session-lock");
  });

  it("handles successful fenced logs plus terminal cancelled and local validation branches", async () => {
    const plane = new ControlPlane({ now: () => "now" });
    const cancelled = { ...running(), status: "cancelled" as const };
    plane.state.sessions.set("s", cancelled);
    plane.state.worktrees.set("w", {
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
    const calls: string[] = [];
    plane.state.storage = {
      getSession: async () => cancelled,
      getHostLock: async () => "c",
      putLogFenced: async () => (calls.push("log"), true),
      deleteLog: async () => {},
      releaseCancelledSessionWorktree: async (opts: {
        fence?: unknown;
        online: boolean;
        concurrencyId?: string;
      }) => {
        calls.push(opts.fence ? `cancel-fenced-${opts.online}` : `cancel-${opts.online}`);
        calls.push(opts.concurrencyId ?? "no-concurrency");
        return true;
      },
    } as never;
    expect(
      await plane.handleHostMessageDurable(
        {
          type: "session:log",
          sessionId: "s",
          stream: "stdout",
          content: "x",
          timestamp: "t",
          seq: 1,
        },
        "c",
      ),
    ).toEqual({ ok: true });
    expect(
      await plane.handleHostMessageDurable({
        type: "session:status",
        sessionId: "s",
        worktreeId: "w",
        attemptId: "a",
        status: "cancelled",
      }),
    ).toEqual({ ok: true });
    expect(calls).toEqual(["log", "cancel-true", "session-lock"]);

    const local = new ControlPlane();
    local.state.sessions.set("done", { ...running("done"), status: "completed" });
    expect(
      local.handleHostMessage({
        type: "session:ack",
        sessionId: "done",
        worktreeId: "w",
        attemptId: "a",
      }),
    ).toEqual({
      ok: true,
    });
    expect(
      local.handleHostMessage({
        type: "session:log",
        sessionId: "done",
        stream: "stdout",
        content: "x".repeat(32 * 1024 + 1),
        timestamp: "t",
        seq: 1,
      }),
    ).toEqual({ ok: false, error: "log chunk exceeds 32 KiB" });
  });
});
