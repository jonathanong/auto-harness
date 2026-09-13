/* eslint-disable max-lines */
import { describe, expect, it, vi } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { createControlPlaneState } from "./control-plane-state.ts";
import { handleHostMessage, handleHostMessageDurable } from "./control-plane-messages.ts";
import { OPERATIONAL_METRIC_ENVIRONMENT_VAR } from "./operational-metrics.ts";

function running(id = "s") {
  return {
    id,
    repositoryId: "r",
    prompt: "p",
    target: { commandId: "cmd" },
    fallbacks: [],
    targetDisplayNames: [],
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

/** Common shape shared by the retry-fence tests below: a terminal report for
 * session "s"/attempt "a", delivered from `sourceConnectionId`, expected to
 * be durably acknowledged. */
async function expectAcknowledgedStatusRetry(
  state: ReturnType<typeof createControlPlaneState>,
  sourceConnectionId: string,
): Promise<void> {
  await expect(
    handleHostMessageDurable(
      state,
      {
        type: "session:status",
        sessionId: "s",
        worktreeId: "w",
        attemptId: "a",
        status: "completed",
      },
      sourceConnectionId,
    ),
  ).resolves.toEqual({
    ok: true,
    sessionStatusAcknowledged: { sessionId: "s", attemptId: "a" },
  });
}

describe("durable host-message fencing", () => {
  it("normalizes object capability advertisements and explicit assignment caps", () => {
    const state = createControlPlaneState({
      now: () => "2026-01-01T00:00:00.000Z",
      connectionIdFactory: () => "connection",
    });

    expect(
      handleHostMessage(state, {
        type: "host:register",
        hostId: "host",
        worktrees: [],
        capabilities: { features: ["scheduled-main-checkout"] },
        maxConcurrentAssignments: 2,
      }),
    ).toEqual({ ok: true });
    expect(state.connections.get("connection")).toMatchObject({
      capabilities: ["scheduled-main-checkout"],
      maxConcurrentAssignments: 2,
    });
  });

  it("releases a timed-out local provider lease on a late terminal report", () => {
    const state = createControlPlaneState({ now: () => "2026-01-01T00:00:00.000Z" });
    const lease = {
      concurrencyId: "provider-lease:account:0",
      providerAccountId: "account",
      slot: 0,
      attemptId: "attempt",
    };
    const row = {
      ...running(),
      status: "timed_out" as const,
      timedOutHostId: "host",
      providerAccountLease: lease,
    };
    state.sessions.set(row.id, row);
    state.providerAccountLeases.set(lease.concurrencyId, {
      sessionId: row.id,
      attemptId: lease.attemptId,
      slot: lease.slot,
      hostId: "host",
      providerAccountId: lease.providerAccountId,
    });

    expect(
      handleHostMessage(state, {
        type: "session:status",
        sessionId: row.id,
        worktreeId: "w",
        attemptId: lease.attemptId,
        status: "completed",
      }),
    ).toEqual({ ok: true });
    expect(state.providerAccountLeases.size).toBe(0);
    expect(state.sessions.get(row.id)).not.toHaveProperty("providerAccountLease");
  });

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
        message: { type: "session:acknowledged", sessionId: "s", attemptId: "a" },
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

  it("acknowledges a durable session:status retry whose own transition already cleared its host claim", async () => {
    const state = createControlPlaneState({ now: () => "now" });
    const requeued = {
      ...running(),
      status: "queued" as const,
      hostId: null,
      worktreeId: null,
    };
    state.sessions.set("s", requeued);
    state.storage = { getSession: async () => requeued } as never;

    await expectAcknowledgedStatusRetry(state, "stale-connection");
  });

  it("replays the durable handoff id on a warm deferred-status retry", async () => {
    const state = createControlPlaneState({ now: () => "now" });
    const replayed = {
      ...running(),
      status: "failed" as const,
      hostId: null,
      worktreeId: null,
      infrastructureRetryAttemptId: "previous-attempt",
      terminalHookHandoff: {
        handoffId: "handoff",
        attemptId: "a",
        hostId: "h",
        repositoryId: "r",
        worktreeId: "w",
        status: "failed" as const,
        errorCode: "checkout_fetch_failed" as const,
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    };
    state.sessions.set("s", replayed);
    state.storage = { getSession: async () => replayed } as never;

    await expect(
      handleHostMessageDurable(
        state,
        {
          type: "session:status",
          sessionId: "s",
          worktreeId: "w",
          attemptId: "a",
          status: "failed",
          errorCode: "checkout_fetch_failed",
          deferTerminalHookResult: true,
        },
        "warm-connection",
      ),
    ).resolves.toEqual({
      ok: true,
      sessionStatusAcknowledged: {
        sessionId: "s",
        attemptId: "a",
        retryAccepted: false,
        terminalHookHandoffId: "handoff",
      },
    });
  });

  it("rejects a session:status retry from a superseded connection while the session is still genuinely running", async () => {
    const state = createControlPlaneState({ now: () => "now" });
    const stillRunning = running();
    state.sessions.set("s", stillRunning);
    state.storage = {
      getSession: async () => stillRunning,
      // The host reconnected on a new connection; the lock no longer matches
      // the stale connection this retry is arriving on.
      getHostLock: async () => "current-connection",
    } as never;

    await expect(
      handleHostMessageDurable(
        state,
        {
          type: "session:status",
          sessionId: "s",
          worktreeId: "w",
          attemptId: "a",
          status: "completed",
        },
        "stale-connection",
      ),
    ).resolves.toEqual({ ok: false, error: "stale host connection" });
  });

  it("acknowledges a session:status retry for an attempt the row has already moved past", async () => {
    const state = createControlPlaneState({ now: () => "now" });
    // The session was requeued off attempt "a" and reassigned to a different
    // host/connection under a fresh attempt "b" before the original daemon's
    // retry for "a" was delivered.
    const reassigned = { ...running(), hostId: "h2", attemptId: "b" };
    state.sessions.set("s", reassigned);
    state.storage = {
      getSession: async () => reassigned,
      getHostLock: async () => "connection-for-h2",
    } as never;

    await expectAcknowledgedStatusRetry(state, "connection-for-h1");
  });

  it("withholds the acknowledgement when a terminal status's conditional write loses a race", async () => {
    const state = createControlPlaneState({ now: () => "now" });
    const stillRunning = running();
    state.sessions.set("s", stillRunning);
    state.storage = {
      getSession: async () => stillRunning,
      // Simulates losing the conditional write to a concurrent transition
      // (e.g. the running-timeout sweep marking the row timed_out first).
      // Nothing was actually committed, so the daemon must keep retrying — a
      // sessionStatusAcknowledged here would let it drop the report forever.
      finishSession: async () => false,
    } as never;

    await expect(
      handleHostMessageDurable(state, {
        type: "session:status",
        sessionId: "s",
        worktreeId: "w",
        attemptId: "a",
        status: "completed",
      }),
    ).resolves.toEqual({ ok: true });
  });

  it("confirms an in-memory terminal status transition and notifies the owning host", () => {
    const deliveries: Array<{ hostId: string; message: unknown }> = [];
    const plane = new ControlPlane({
      now: () => "now",
      onHostMessage: (hostId, message) => deliveries.push({ hostId, message }),
    });
    plane.state.sessions.set("s", running());

    const frame = {
      type: "session:status" as const,
      sessionId: "s",
      worktreeId: "w",
      attemptId: "a",
      status: "completed" as const,
    };
    expect(plane.handleHostMessage(frame)).toEqual({ ok: true });
    expect(deliveries).toEqual([
      {
        hostId: "h",
        message: { type: "session:status-acknowledged", sessionId: "s", attemptId: "a" },
      },
    ]);
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
    let drained = 0;
    plane.state.storage.markHostDraining = async () => (drained++, true);
    expect(
      await plane.handleHostMessageDurable(
        { type: "host:status", hostId: "h", draining: true },
        "stale",
      ),
    ).toEqual({ ok: false, error: "stale host connection" });
    expect(drained).toBe(0);
    expect(
      await plane.handleHostMessageDurable(
        { type: "host:status", hostId: "h", draining: true },
        "current",
      ),
    ).toEqual({ ok: true, hostDraining: "h" });
    expect(drained).toBe(1);
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
    // A frame carrying a sourceConnectionId already verified against the
    // durable lock (this call's own fence check, just above) must reach
    // heartbeatDurable as-is rather than falling back through the local
    // hostConnection cache — see the comment on heartbeatDurable's
    // sourceConnectionId parameter for why that matters.
    let heartbeatConnectionCalledWith: [string, string, string] | undefined;
    plane.state.storage!.heartbeatConnection = async (
      hostId: string,
      connectionId: string,
      at: string,
    ) => {
      heartbeatConnectionCalledWith = [hostId, connectionId, at];
      return true;
    };
    expect(
      await plane.handleHostMessageDurable(
        { type: "host:keepalive", hostId: "h", at: "fenced" },
        "current",
      ),
    ).toEqual({ ok: true });
    expect(heartbeatConnectionCalledWith).toEqual(["h", "current", "fenced"]);
    expect(
      await plane.handleHostMessageDurable({
        type: "session:status",
        sessionId: "s",
        worktreeId: "w",
        attemptId: "a",
        status: "running",
      }),
    ).toEqual({
      ok: true,
      sessionStatusAcknowledged: { sessionId: "s", attemptId: "a" },
    });
  });

  it("enforces the same source fence for an in-memory drain request", async () => {
    const plane = new ControlPlane();
    plane.state.hostConnection.set("h", "current");
    expect(
      await plane.handleHostMessageDurable(
        { type: "host:status", hostId: "h", draining: true },
        "stale",
      ),
    ).toEqual({ ok: false, error: "stale host connection" });
    expect(plane.isDraining("h")).toBe(false);
    expect(
      await plane.handleHostMessageDurable(
        { type: "host:status", hostId: "h", draining: true },
        "current",
      ),
    ).toEqual({ ok: true });
    expect(plane.isDraining("h")).toBe(true);
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
      listLogs: async () => [],
      putArchive: async () => {},
    } as never;
    expect(
      await plane.handleHostMessageDurable(
        {
          type: "session:log",
          sessionId: "s",
          attemptId: "a",
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
    ).toEqual({
      ok: true,
      sessionStatusAcknowledged: { sessionId: "s", attemptId: "a" },
    });
    expect(logFence).toBe(false);
    expect(statusFence).toBe(true);
    expect(statusConcurrencyId).toBe("session-lock");
  });

  it("counts a stale-attempt session:log discard on the durable single-message path", async () => {
    const state = createControlPlaneState({ now: () => "now" });
    const reassigned = { ...running(), attemptId: "b" };
    state.sessions.set("s", reassigned);
    state.storage = { getSession: async () => reassigned } as never;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    process.env[OPERATIONAL_METRIC_ENVIRONMENT_VAR] = "test";
    try {
      await expect(
        handleHostMessageDurable(state, {
          type: "session:log",
          sessionId: "s",
          attemptId: "a",
          stream: "stdout",
          content: "stale",
          timestamp: "t",
          seq: 1,
        }),
      ).resolves.toEqual({ ok: true });
      expect(state.logs.get("s")).toBeUndefined();
      expect(log.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual(
        expect.arrayContaining([expect.objectContaining({ StaleAttemptLogDrops: 1 })]),
      );
    } finally {
      delete process.env[OPERATIONAL_METRIC_ENVIRONMENT_VAR];
      log.mockRestore();
    }
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
          attemptId: "a",
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
    ).toEqual({
      ok: true,
      sessionStatusAcknowledged: { sessionId: "s", attemptId: "a" },
    });
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
        attemptId: "a",
        stream: "stdout",
        content: "x".repeat(32 * 1024 + 1),
        timestamp: "t",
        seq: 1,
      }),
    ).toEqual({ ok: false, error: "log chunk exceeds 32 KiB" });
  });
});
