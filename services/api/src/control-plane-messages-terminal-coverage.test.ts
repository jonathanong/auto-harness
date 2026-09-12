/* eslint-disable max-lines */
import { describe, expect, it, vi } from "vitest";

import { setDurableReadStorage } from "../test-helpers/control-plane-durable-read-test-helpers.ts";
import { handleHostMessage, handleHostMessageDurable } from "./control-plane-messages.ts";
import { createControlPlaneState } from "./control-plane-state.ts";
import type { SessionRecord, WorktreeRecord } from "./db/types.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function running(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "session",
    repositoryId: "repo",
    prompt: "run",
    target: { commandId: "command" },
    fallbacks: [],
    targetDisplayNames: ["command"],
    queueTtlSeconds: 60,
    queueExpiresAt: "2026-01-01T01:00:00.000Z",
    timeout: 60,
    priority: 0,
    requiredLabels: [],
    status: "running",
    queueShard: 0,
    createdAt: NOW,
    hostId: "host",
    worktreeId: "worktree",
    attemptId: "attempt",
    ...overrides,
  };
}

function failedCheckoutStatus(sessionId = "session", worktreeId: string | null = "worktree") {
  return {
    type: "session:status" as const,
    sessionId,
    worktreeId,
    attemptId: "attempt",
    status: "failed" as const,
    errorCode: "checkout_fetch_failed" as const,
    deferTerminalHookResult: true as const,
  };
}

function busyWorktree(): WorktreeRecord {
  return {
    id: "worktree",
    hostId: "host",
    repositoryId: "repo",
    status: "busy",
    currentSessionId: "session",
  } as WorktreeRecord;
}

describe("control-plane terminal message coverage", () => {
  it("replays a pending terminal hook with its optional context on a modern registration", () => {
    const deliveries: unknown[] = [];
    const state = createControlPlaneState({
      onHostMessage: (_hostId, message) => deliveries.push(message),
    });
    state.sessions.set(
      "session",
      running({
        status: "failed",
        worktreeId: null,
        terminalHookHandoff: {
          handoffId: "handoff",
          hostId: "host",
          repositoryId: "repo",
          worktreeId: "worktree",
          status: "failed",
          errorCode: "checkout_fetch_failed",
          ref: "feature/terminal-hook",
          metadata: { createdBy: "operator" },
          expiresAt: "2026-01-02T00:00:00.000Z",
        },
      }),
    );

    expect(
      handleHostMessage(state, {
        type: "host:register",
        hostId: "host",
        worktrees: [],
        protocolVersion: 6,
      }),
    ).toEqual({ ok: true });
    expect(deliveries).toEqual([
      {
        type: "session:terminal-hook",
        handoffId: "handoff",
        sessionId: "session",
        repositoryId: "repo",
        worktreeId: "worktree",
        status: "failed",
        errorCode: "checkout_fetch_failed",
        ref: "feature/terminal-hook",
        metadata: { createdBy: "operator" },
      },
    ]);
  });

  it("replays a pending terminal hook without optional context on a modern registration", () => {
    const deliveries: unknown[] = [];
    const state = createControlPlaneState({
      onHostMessage: (_hostId, message) => deliveries.push(message),
    });
    state.sessions.set(
      "session",
      running({
        status: "failed",
        worktreeId: null,
        terminalHookHandoff: {
          handoffId: "handoff",
          hostId: "host",
          repositoryId: "repo",
          worktreeId: null,
          status: "failed",
          expiresAt: "2026-01-02T00:00:00.000Z",
        },
      }),
    );

    expect(
      handleHostMessage(state, {
        type: "host:register",
        hostId: "host",
        worktrees: [],
        protocolVersion: 6,
      }),
    ).toEqual({ ok: true });
    expect(deliveries).toEqual([
      {
        type: "session:terminal-hook",
        handoffId: "handoff",
        sessionId: "session",
        repositoryId: "repo",
        worktreeId: null,
        status: "failed",
      },
    ]);
  });

  it("confirms a local first checkout failure with its accepted retry disposition", () => {
    const deliveries: unknown[] = [];
    const state = createControlPlaneState({
      now: () => NOW,
      onHostMessage: (_hostId, message) => deliveries.push(message),
    });
    state.sessions.set("session", running());
    state.worktrees.set("worktree", busyWorktree());

    expect(handleHostMessage(state, failedCheckoutStatus())).toEqual({ ok: true });
    expect(state.sessions.get("session")).toMatchObject({
      status: "queued",
      infrastructureRetryCount: 1,
    });
    expect(deliveries).toEqual([
      {
        type: "session:status-acknowledged",
        sessionId: "session",
        attemptId: "attempt",
        retryAccepted: true,
      },
    ]);
  });

  it("keeps a locally requeued scheduled checkout failure queued when its background sweep fails", async () => {
    const state = createControlPlaneState({ now: () => NOW });
    const backfillQueuedSessionQueueOrder = vi.fn(async () => {
      throw new Error("scheduler read model unavailable");
    });
    const session = running({
      type: "scheduled",
      worktreeId: null,
      mainCheckoutLease: true,
      assignmentConnectionId: "connection",
    });
    state.sessions.set(session.id, session);
    state.mainCheckoutLeases.set("host\0repo", {
      sessionId: session.id,
      connectionId: "connection",
    });
    setDurableReadStorage(state, { backfillQueuedSessionQueueOrder });

    expect(handleHostMessage(state, failedCheckoutStatus("session", null))).toEqual({ ok: true });
    await vi.waitFor(() => expect(backfillQueuedSessionQueueOrder).toHaveBeenCalledOnce());
    expect(state.sessions.get(session.id)).toMatchObject({
      status: "queued",
      infrastructureRetryCount: 1,
    });
  });

  it("rejects a completion for a different handoff even from the current host connection", async () => {
    const state = createControlPlaneState({ now: () => NOW });
    const session = running({
      status: "failed",
      worktreeId: null,
      terminalHookHandoff: {
        handoffId: "expected",
        hostId: "host",
        repositoryId: "repo",
        worktreeId: "worktree",
        status: "failed",
        expiresAt: "2026-01-02T00:00:00.000Z",
      },
    });
    const settleTerminalHookHandoff = vi.fn(async () => true);
    setDurableReadStorage(state, {
      getSession: async () => session,
      getHostLock: async () => "connection",
      settleTerminalHookHandoff,
    });

    await expect(
      handleHostMessageDurable(
        state,
        {
          type: "session:terminal-hook-complete",
          sessionId: "session",
          handoffId: "wrong",
        },
        "connection",
      ),
    ).resolves.toEqual({ ok: false, error: "terminal hook handoff not found" });
    expect(settleTerminalHookHandoff).not.toHaveBeenCalled();
  });

  it("acknowledges a local handoff completion with no result through the current connection", async () => {
    const deliveries: unknown[] = [];
    const state = createControlPlaneState({
      onHostMessage: (_hostId, message) => deliveries.push(message),
    });
    state.hostConnection.set("host", "connection");
    state.sessions.set(
      "session",
      running({
        status: "failed",
        terminalHookHandoff: {
          handoffId: "handoff",
          hostId: "host",
          repositoryId: "repo",
          worktreeId: "worktree",
          status: "failed",
          expiresAt: "2026-01-02T00:00:00.000Z",
        },
      }),
    );

    expect(
      handleHostMessage(
        state,
        { type: "session:terminal-hook-complete", sessionId: "session", handoffId: "handoff" },
        "connection",
      ),
    ).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(deliveries).toEqual([
        {
          type: "session:terminal-hook-acknowledged",
          sessionId: "session",
          handoffId: "handoff",
        },
      ]),
    );
    expect(state.sessions.get("session")).not.toHaveProperty("terminalHookHandoff");
  });

  it("rejects a missing local handoff and withholds acknowledgement without a source connection", async () => {
    const deliveries: unknown[] = [];
    const state = createControlPlaneState({
      onHostMessage: (_hostId, message) => deliveries.push(message),
    });
    expect(
      handleHostMessage(state, {
        type: "session:terminal-hook-complete",
        sessionId: "missing",
        handoffId: "handoff",
      }),
    ).toEqual({ ok: false, error: "terminal hook handoff not found" });

    state.sessions.set(
      "session",
      running({
        status: "failed",
        terminalHookHandoff: {
          handoffId: "handoff",
          hostId: "host",
          repositoryId: "repo",
          worktreeId: "worktree",
          status: "failed",
          expiresAt: "2026-01-02T00:00:00.000Z",
        },
      }),
    );
    expect(
      handleHostMessage(state, {
        type: "session:terminal-hook-complete",
        sessionId: "session",
        handoffId: "handoff",
      }),
    ).toEqual({ ok: true });
    await Promise.resolve();
    expect(deliveries).toEqual([]);
    expect(state.sessions.get("session")).toHaveProperty("terminalHookHandoff");
  });

  it("normalizes and acknowledges a local handoff completion with a post-hook result", async () => {
    const deliveries: unknown[] = [];
    const state = createControlPlaneState({
      onHostMessage: (_hostId, message) => deliveries.push(message),
    });
    state.hostConnection.set("host", "connection");
    state.sessions.set(
      "session",
      running({
        status: "failed",
        terminalHookHandoff: {
          handoffId: "handoff",
          hostId: "host",
          repositoryId: "repo",
          worktreeId: "worktree",
          status: "failed",
          expiresAt: "2026-01-02T00:00:00.000Z",
        },
      }),
    );

    expect(
      handleHostMessage(
        state,
        {
          type: "session:terminal-hook-complete",
          sessionId: "session",
          handoffId: "handoff",
          result: { summary: "post-hook", summarySource: "harness" },
        },
        "connection",
      ),
    ).toEqual({ ok: true });
    await vi.waitFor(() => expect(deliveries).toHaveLength(1));
    expect(state.sessions.get("session")?.result).toEqual({
      summary: "post-hook",
      summarySource: "harness",
    });
  });

  it("acknowledges a matching durable handoff completion without a post-hook result", async () => {
    const state = createControlPlaneState({ now: () => NOW });
    const session = running({
      status: "failed",
      worktreeId: null,
      terminalHookHandoff: {
        handoffId: "handoff",
        hostId: "host",
        repositoryId: "repo",
        worktreeId: null,
        status: "failed",
        expiresAt: "2026-01-02T00:00:00.000Z",
      },
    });
    const settleTerminalHookHandoff = vi.fn(async () => true);
    setDurableReadStorage(state, {
      getSession: async () => session,
      getHostLock: async () => "connection",
      settleTerminalHookHandoff,
      listLogs: async () => [],
      putArchive: async () => undefined,
    });

    await expect(
      handleHostMessageDurable(
        state,
        { type: "session:terminal-hook-complete", sessionId: "session", handoffId: "handoff" },
        "connection",
      ),
    ).resolves.toEqual({
      ok: true,
      sessionTerminalHookAcknowledged: { sessionId: "session", handoffId: "handoff" },
    });
    expect(settleTerminalHookHandoff).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: "connection" }),
    );
  });

  it("normalizes a durable handoff completion result before fenced settlement", async () => {
    const state = createControlPlaneState({ now: () => NOW });
    const session = running({
      status: "failed",
      worktreeId: null,
      terminalHookHandoff: {
        handoffId: "handoff",
        hostId: "host",
        repositoryId: "repo",
        worktreeId: null,
        status: "failed",
        expiresAt: "2026-01-02T00:00:00.000Z",
      },
    });
    const settleTerminalHookHandoff = vi.fn(async () => true);
    setDurableReadStorage(state, {
      getSession: async () => session,
      getHostLock: async () => "connection",
      settleTerminalHookHandoff,
      listLogs: async () => [],
      putArchive: async () => undefined,
    });

    await expect(
      handleHostMessageDurable(
        state,
        {
          type: "session:terminal-hook-complete",
          sessionId: "session",
          handoffId: "handoff",
          result: { summary: "post-hook", summarySource: "harness" },
        },
        "connection",
      ),
    ).resolves.toMatchObject({
      ok: true,
      sessionTerminalHookAcknowledged: { sessionId: "session", handoffId: "handoff" },
    });
    expect(settleTerminalHookHandoff).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: "connection",
        result: { summary: "post-hook", summarySource: "harness" },
      }),
    );
  });

  it("withholds a durable deferred status acknowledgement when its handoff was not committed", async () => {
    const state = createControlPlaneState({ now: () => NOW, idFactory: () => "proposed" });
    const session = running({ infrastructureRetryCount: 1 });
    const finishSession = vi.fn(async () => true);
    setDurableReadStorage(state, {
      getSession: async () => session,
      finishSession,
    });
    state.sessions.set(session.id, session);

    await expect(
      handleHostMessageDurable(state, failedCheckoutStatus(), undefined, false, false, 6),
    ).resolves.toEqual({ ok: true });
    expect(finishSession).toHaveBeenCalledWith(
      expect.objectContaining({
        terminalHookHandoff: expect.objectContaining({ handoffId: "proposed" }),
      }),
    );
    expect(state.sessions.get(session.id)).toEqual(session);
  });

  it("finishes a hostless deferred failure without fabricating a terminal hook handoff", async () => {
    const state = createControlPlaneState({ now: () => NOW });
    const session = running({ hostId: null, infrastructureRetryCount: 1 });
    const finishSession = vi.fn(async () => true);
    setDurableReadStorage(state, {
      getSession: async () => session,
      finishSession,
      listLogs: async () => [],
      putArchive: async () => undefined,
    });

    await expect(
      handleHostMessageDurable(state, failedCheckoutStatus(), undefined, false, false, 6),
    ).resolves.toMatchObject({ ok: true, sessionStatusAcknowledged: { sessionId: "session" } });
    expect(finishSession).toHaveBeenCalledWith(
      expect.not.objectContaining({ terminalHookHandoff: expect.anything() }),
    );
  });

  it("retains deferred main-checkout context from the terminal status through its durable handoff", async () => {
    const state = createControlPlaneState({ now: () => NOW, idFactory: () => "proposed" });
    const session = running({
      type: "scheduled",
      worktreeId: null,
      mainCheckoutLease: true,
      assignmentConnectionId: "connection",
      infrastructureRetryCount: 1,
      ref: "feature/terminal-hook",
      metadata: { createdBy: "operator" },
    });
    let persisted = session;
    const releaseMainCheckoutSession = vi.fn(
      async (input: { terminalHookHandoff?: SessionRecord["terminalHookHandoff"] }) => {
        if (!input.terminalHookHandoff) return false;
        persisted = {
          ...session,
          status: "failed",
          worktreeId: null,
          terminalHookHandoff: input.terminalHookHandoff,
        };
        return true;
      },
    );
    setDurableReadStorage(state, {
      getSession: async () => persisted,
      releaseMainCheckoutSession,
      listLogs: async () => [],
      putArchive: async () => undefined,
    });
    state.mainCheckoutLeases.set("host\0repo", {
      sessionId: "session",
      connectionId: "connection",
    });

    await expect(
      handleHostMessageDurable(
        state,
        failedCheckoutStatus("session", null),
        undefined,
        false,
        false,
        6,
      ),
    ).resolves.toMatchObject({
      sessionStatusAcknowledged: { terminalHookHandoffId: "proposed", retryAccepted: false },
    });
    expect(releaseMainCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({
        terminalHookHandoff: expect.objectContaining({
          handoffId: "proposed",
          mainCheckoutLease: true,
          ref: "feature/terminal-hook",
          metadata: { createdBy: "operator" },
        }),
      }),
    );
  });

  it("withholds acknowledgement when a durable main-checkout handoff conditional write loses", async () => {
    const state = createControlPlaneState({ now: () => NOW, idFactory: () => "proposed" });
    const session = running({
      type: "scheduled",
      worktreeId: null,
      mainCheckoutLease: true,
      assignmentConnectionId: "connection",
      infrastructureRetryCount: 1,
    });
    const releaseMainCheckoutSession = vi.fn(async () => true);
    setDurableReadStorage(state, {
      getSession: async () => session,
      releaseMainCheckoutSession,
    });

    await expect(
      handleHostMessageDurable(
        state,
        failedCheckoutStatus("session", null),
        undefined,
        false,
        false,
        6,
      ),
    ).resolves.toEqual({ ok: true });
    expect(releaseMainCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({
        terminalHookHandoff: expect.objectContaining({ handoffId: "proposed" }),
      }),
    );
  });

  it("durably requeues a first checkout failure and confirms its retry disposition", async () => {
    const state = createControlPlaneState({ now: () => NOW });
    const session = running();
    const tryRequeueSession = vi.fn(async () => true);
    setDurableReadStorage(state, {
      getSession: async () => session,
      tryRequeueSession,
      listSessionsByStatusPage: async () => [],
      listConnections: async () => [],
      listHostInventories: async () => [],
    });

    await expect(
      handleHostMessageDurable(state, failedCheckoutStatus(), undefined, false, false, 6),
    ).resolves.toMatchObject({
      sessionStatusAcknowledged: { sessionId: "session", retryAccepted: true },
    });
    expect(tryRequeueSession).toHaveBeenCalledWith(
      expect.objectContaining({
        infrastructureErrorCode: "checkout_fetch_failed",
        reason: "checkout fetch failed; retrying once",
      }),
    );
  });

  it("finishes an exhausted durable checkout retry instead of attempting another requeue", async () => {
    const state = createControlPlaneState({ now: () => NOW });
    const session = running({ infrastructureRetryCount: 1 });
    const finishSession = vi.fn(async () => true);
    setDurableReadStorage(state, {
      getSession: async () => session,
      finishSession,
      listLogs: async () => [],
      putArchive: async () => undefined,
    });

    await expect(
      handleHostMessageDurable(
        state,
        { ...failedCheckoutStatus(), deferTerminalHookResult: false },
        undefined,
        false,
        false,
        6,
      ),
    ).resolves.toMatchObject({ sessionStatusAcknowledged: { sessionId: "session" } });
    expect(finishSession).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "checkout_fetch_failed" }),
    );
  });

  it("releases a scheduled main-checkout terminal without a retry error", async () => {
    const state = createControlPlaneState({ now: () => NOW });
    const session = running({
      type: "scheduled",
      worktreeId: null,
      mainCheckoutLease: true,
      assignmentConnectionId: "connection",
    });
    const releaseMainCheckoutSession = vi.fn(async () => true);
    setDurableReadStorage(state, {
      releaseMainCheckoutSession,
      listLogs: async () => [],
      putArchive: async () => undefined,
    });
    state.sessions.set(session.id, session);

    await expect(
      handleHostMessageDurable(state, {
        type: "session:status",
        sessionId: session.id,
        worktreeId: null,
        attemptId: "attempt",
        status: "completed",
      }),
    ).resolves.toMatchObject({ ok: true, sessionStatusAcknowledged: { sessionId: "session" } });
    expect(releaseMainCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({ status: "completed" }),
    );
  });

  it("releases a scheduled main-checkout checkout failure after retry exhaustion", async () => {
    const state = createControlPlaneState({ now: () => NOW });
    const session = running({
      type: "scheduled",
      worktreeId: null,
      mainCheckoutLease: true,
      assignmentConnectionId: "connection",
      infrastructureRetryCount: 1,
    });
    const releaseMainCheckoutSession = vi.fn(async () => true);
    setDurableReadStorage(state, {
      releaseMainCheckoutSession,
      listLogs: async () => [],
      putArchive: async () => undefined,
    });
    state.sessions.set(session.id, session);

    await expect(
      handleHostMessageDurable(state, {
        type: "session:status",
        sessionId: session.id,
        worktreeId: null,
        attemptId: "attempt",
        status: "failed",
        errorCode: "checkout_fetch_failed",
      }),
    ).resolves.toMatchObject({ ok: true, sessionStatusAcknowledged: { sessionId: "session" } });
    expect(releaseMainCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", errorCode: "checkout_fetch_failed" }),
    );
  });

  it("withholds a durable terminal-hook acknowledgement when settlement loses its race", async () => {
    const state = createControlPlaneState({ now: () => NOW });
    const session = running({
      status: "failed",
      worktreeId: null,
      terminalHookHandoff: {
        handoffId: "handoff",
        hostId: "host",
        repositoryId: "repo",
        worktreeId: null,
        status: "failed",
        expiresAt: "2026-01-02T00:00:00.000Z",
      },
    });
    setDurableReadStorage(state, {
      getSession: async () => session,
      getHostLock: async () => "connection",
      settleTerminalHookHandoff: async () => false,
    });

    await expect(
      handleHostMessageDurable(
        state,
        { type: "session:terminal-hook-complete", sessionId: "session", handoffId: "handoff" },
        "connection",
      ),
    ).resolves.toEqual({ ok: false, error: "terminal hook handoff not found" });
  });

  it("covers local terminal finish and retry disposition branches", () => {
    const state = createControlPlaneState({ now: () => NOW });
    const session = running({ worktreeId: "worktree" });
    state.sessions.set(session.id, session);
    state.worktrees.set("worktree", busyWorktree());

    expect(
      handleHostMessage(state, {
        type: "session:status",
        sessionId: session.id,
        worktreeId: "worktree",
        attemptId: "attempt",
        status: "completed",
      }),
    ).toEqual({ ok: true });
    expect(state.sessions.get(session.id)).toMatchObject({ status: "completed" });
  });

  it("requeues a prompt session through the local infrastructure retry path", () => {
    const state = createControlPlaneState({ now: () => NOW });
    const session = running({ worktreeId: "worktree" });
    state.sessions.set(session.id, session);
    state.worktrees.set("worktree", busyWorktree());

    expect(
      handleHostMessage(state, {
        type: "session:status",
        sessionId: session.id,
        worktreeId: "worktree",
        attemptId: "attempt",
        status: "failed",
        errorCode: "checkout_fetch_failed",
      }),
    ).toEqual({ ok: true });
    expect(state.sessions.get(session.id)).toMatchObject({
      status: "queued",
      infrastructureRetryCount: 1,
    });
  });

  it("finishes a locally authorized checkout failure after retry exhaustion", () => {
    const state = createControlPlaneState({ now: () => NOW });
    const session = running({
      worktreeId: "worktree",
      primaryCommandStartState: "authorized",
      infrastructureRetryCount: 1,
    });
    state.sessions.set(session.id, session);
    state.worktrees.set("worktree", busyWorktree());

    expect(
      handleHostMessage(state, {
        type: "session:status",
        sessionId: session.id,
        worktreeId: "worktree",
        attemptId: "attempt",
        status: "failed",
        errorCode: "checkout_fetch_failed",
      }),
    ).toEqual({ ok: true });
    expect(state.sessions.get(session.id)).toMatchObject({
      status: "failed",
      errorCode: "checkout_fetch_failed",
    });
  });

  it("requeues a first checkout failure for a leased scheduled run", async () => {
    const state = createControlPlaneState({ now: () => NOW });
    const session = running({
      type: "scheduled",
      worktreeId: null,
      mainCheckoutLease: true,
      assignmentConnectionId: "connection",
    });
    const releaseMainCheckoutSession = vi.fn(async () => true);
    setDurableReadStorage(state, {
      releaseMainCheckoutSession,
      listSessionsByStatusPage: async () => [],
      listConnections: async () => [],
      listHostInventories: async () => [],
    });
    state.sessions.set(session.id, session);

    await expect(
      handleHostMessageDurable(state, {
        type: "session:status",
        sessionId: session.id,
        worktreeId: null,
        attemptId: "attempt",
        status: "failed",
        errorCode: "checkout_fetch_failed",
      }),
    ).resolves.toMatchObject({ ok: true, sessionStatusAcknowledged: { sessionId: "session" } });
    expect(releaseMainCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "queued",
        infrastructureErrorCode: "checkout_fetch_failed",
      }),
    );
  });

  it("does not expose a local reconciliation handoff to a legacy keepalive", async () => {
    const state = createControlPlaneState({ now: () => NOW, idFactory: () => "handoff" });
    state.hostConnection.set("host", "connection");
    state.connections.set("connection", {
      type: "host",
      hostId: "host",
      connectionId: "connection",
      connectedAt: NOW,
      lastHeartbeatAt: NOW,
      repositoryIds: ["repo"],
      commandProfiles: [],
      capabilities: [],
      protocolVersion: 4,
      runtime: { daemonVersion: "test", gitVersion: "2.36.0", gitReady: true },
    });
    state.sessions.set(
      "session",
      running({
        ackReceivedAt: NOW,
        primaryCommandStartState: "authorized",
        activeHostId: "host",
        activeHostOrder: `${NOW}#session`,
      }),
    );
    state.worktrees.set("worktree", { ...busyWorktree(), online: true });

    await expect(
      handleHostMessageDurable(state, {
        type: "host:keepalive",
        hostId: "host",
        at: NOW,
        runningSessions: [],
      }),
    ).resolves.toEqual({ ok: true });
    expect(state.sessions.get("session")?.terminalHookHandoff).toMatchObject({
      handoffId: "handoff",
    });
  });

  it("does not expose a durable reconciliation handoff to a legacy keepalive", async () => {
    const state = createControlPlaneState({ now: () => NOW, idFactory: () => "handoff" });
    const session = running({
      ackReceivedAt: NOW,
      primaryCommandStartState: "authorized",
      activeHostId: "host",
      activeHostOrder: `${NOW}#session`,
    });
    const worktree = { ...busyWorktree(), online: true };
    const finishSession = vi.fn(async () => true);
    setDurableReadStorage(state, {
      getHostLock: async () => "connection",
      heartbeatConnection: async () => true,
      listActiveSessionsByHost: async () => [session],
      getWorktree: async () => worktree,
      finishSession,
    });

    await expect(
      handleHostMessageDurable(
        state,
        { type: "host:keepalive", hostId: "host", at: NOW, runningSessions: [] },
        "connection",
        false,
        false,
        4,
      ),
    ).resolves.toEqual({ ok: true });
    expect(finishSession).toHaveBeenCalledWith(
      expect.objectContaining({
        terminalHookHandoff: expect.objectContaining({ handoffId: "handoff" }),
      }),
    );
  });

  it("replays an already resolved deferred checkout failure with its stored handoff id", async () => {
    const state = createControlPlaneState({ now: () => NOW });
    const session = running({
      status: "failed",
      worktreeId: null,
      terminalHookHandoff: {
        handoffId: "settled-handoff",
        hostId: "host",
        repositoryId: "repo",
        worktreeId: "worktree",
        status: "failed",
        errorCode: "checkout_fetch_failed",
        expiresAt: "2026-01-02T00:00:00.000Z",
      },
    });
    setDurableReadStorage(state, { getSession: async () => session });

    await expect(
      handleHostMessageDurable(state, failedCheckoutStatus(), undefined, false, false, 6),
    ).resolves.toMatchObject({
      ok: true,
      sessionStatusAcknowledged: {
        sessionId: "session",
        attemptId: "attempt",
        retryAccepted: false,
        terminalHookHandoffId: "settled-handoff",
      },
    });
  });

  it("covers durable ignored terminal reports with each optional handoff guard", async () => {
    const cases: Array<{
      session: SessionRecord;
      message:
        | ReturnType<typeof failedCheckoutStatus>
        | {
            type: "session:status";
            sessionId: string;
            worktreeId: string;
            attemptId: string;
            status: "completed";
          };
    }> = [
      {
        session: running({ status: "failed", infrastructureRetryCount: 1 }),
        message: {
          type: "session:status",
          sessionId: "session",
          worktreeId: "worktree",
          attemptId: "attempt",
          status: "completed",
        },
      },
      {
        session: running({
          status: "failed",
          infrastructureRetryCount: 1,
          terminalHookHandoff: {
            handoffId: "handoff",
            hostId: "host",
            repositoryId: "repo",
            worktreeId: "worktree",
            status: "failed",
            errorCode: "checkout_fetch_failed",
            expiresAt: "2026-01-02T00:00:00.000Z",
          },
        }),
        message: { ...failedCheckoutStatus(), deferTerminalHookResult: false },
      },
      {
        session: running({
          status: "failed",
          infrastructureRetryCount: 1,
          terminalHookHandoff: {
            handoffId: "handoff",
            hostId: "host",
            repositoryId: "repo",
            worktreeId: "worktree",
            status: "failed",
            errorCode: "host_lost",
            expiresAt: "2026-01-02T00:00:00.000Z",
          },
        }),
        message: failedCheckoutStatus(),
      },
    ];

    for (const fixture of cases) {
      const state = createControlPlaneState({ now: () => NOW });
      setDurableReadStorage(state, { getSession: async () => fixture.session });
      await expect(handleHostMessageDurable(state, fixture.message)).resolves.toMatchObject({
        ok: true,
      });
    }
  });

  it("tolerates a provider account disappearing while applying a local cooldown", () => {
    const state = createControlPlaneState({ now: () => NOW });
    const account = {
      id: "account",
      providerId: "provider",
      label: "account",
      usageLimitCooldownSeconds: 30,
      maxConcurrentSessions: 1,
      usageLimitedUntil: null,
      lastUsageLimitedAt: null,
      lastAssignedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const session = running({
      resolvedRoute: {
        targetIndex: 0,
        commandId: "command",
        providerAccountId: account.id,
        hostId: "host",
        worktreeId: "worktree",
        attemptId: "attempt",
      },
    });
    state.sessions.set(session.id, session);
    state.worktrees.set("worktree", busyWorktree());
    const get = vi.spyOn(state.providerAccounts, "get");
    get.mockReturnValueOnce(account).mockReturnValueOnce(undefined);

    expect(
      handleHostMessage(state, {
        type: "session:status",
        sessionId: session.id,
        worktreeId: "worktree",
        attemptId: "attempt",
        status: "failed",
        errorCode: "usage_limit",
      }),
    ).toEqual({ ok: true });
    expect(state.sessions.get(session.id)).toMatchObject({ status: "queued" });
  });
});
