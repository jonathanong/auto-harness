/* eslint-disable max-lines -- registration, keepalive retry, and requeue branches share this fixture. */
import { describe, expect, it } from "vitest";

import { handleHostMessage, handleHostMessageDurable } from "./control-plane-messages.ts";
import { registerHost, registerHostDurable } from "./control-plane-agents.ts";
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
    activeHostId: "host",
    activeHostOrder: `${NOW}#session`,
    ...overrides,
  };
}

function busyWorktree(): WorktreeRecord {
  return {
    id: "worktree",
    hostId: "host",
    repositoryId: "repo",
    status: "busy",
    currentSessionId: "session",
    online: true,
  } as WorktreeRecord;
}

function pendingHandoff(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return running({
    status: "failed",
    worktreeId: null,
    terminalHookHandoff: {
      handoffId: "handoff",
      hostId: "host",
      repositoryId: "repo",
      worktreeId: "worktree",
      status: "failed",
      expiresAt: "2026-01-02T00:00:00.000Z",
    },
    ...overrides,
  });
}

describe("in-memory recovery handoff delivery", () => {
  it("does not push recovery handoffs through onHostMessage during register", () => {
    const deliveries: unknown[] = [];
    const state = createControlPlaneState({
      now: () => NOW,
      onHostMessage: (_hostId, message) => deliveries.push(message),
    });
    state.sessions.set("session", pendingHandoff());

    expect(
      handleHostMessage(state, {
        type: "host:register",
        hostId: "host",
        worktrees: [],
        protocolVersion: 7,
      }),
    ).toEqual({ ok: true });
    expect(deliveries).toEqual([]);
  });

  it("returns omitted-session handoffs from storage-less registration after reconcile", async () => {
    const deliveries: unknown[] = [];
    const state = createControlPlaneState({
      now: () => NOW,
      idFactory: () => "handoff",
      onHostMessage: (_hostId, message) => deliveries.push(message),
    });
    expect(
      handleHostMessage(state, {
        type: "host:register",
        hostId: "host",
        worktrees: [],
        protocolVersion: 7,
      }),
    ).toEqual({ ok: true });
    state.sessions.set(
      "session",
      running({
        ackReceivedAt: NOW,
        primaryCommandStartState: "authorized",
      }),
    );
    state.worktrees.set("worktree", busyWorktree());

    await expect(
      handleHostMessageDurable(
        state,
        {
          type: "host:register",
          hostId: "host",
          worktrees: [],
          protocolVersion: 7,
          runningSessions: [],
        },
        undefined,
        true,
      ),
    ).resolves.toMatchObject({
      ok: true,
      terminalHookHandoffs: [
        expect.objectContaining({
          type: "session:terminal-hook",
          handoffId: "handoff",
          sessionId: "session",
        }),
      ],
    });
    expect(deliveries).toEqual([]);
  });

  it("re-lists a pre-existing pending handoff on a healthy local keepalive", async () => {
    const state = createControlPlaneState({ now: () => NOW });
    state.hostConnection.set("host", "connection");
    state.connections.set("connection", {
      type: "host",
      hostId: "host",
      connectionId: "connection",
      connectedAt: NOW,
      lastHeartbeatAt: NOW,
      repositoryIds: ["repo"],
      capabilities: [],
      protocolVersion: 7,
    });
    state.sessions.set("session", pendingHandoff());

    await expect(
      handleHostMessageDurable(state, {
        type: "host:keepalive",
        hostId: "host",
        at: NOW,
      }),
    ).resolves.toMatchObject({
      ok: true,
      terminalHookHandoffs: [
        expect.objectContaining({
          type: "session:terminal-hook",
          handoffId: "handoff",
          sessionId: "session",
        }),
      ],
    });
  });

  it("returns a failed storage-less replacement register without listing handoffs", async () => {
    const state = createControlPlaneState({ now: () => NOW });
    expect(
      handleHostMessage(state, {
        type: "host:register",
        hostId: "host",
        worktrees: [],
        protocolVersion: 7,
      }),
    ).toEqual({ ok: true });

    await expect(
      handleHostMessageDurable(state, {
        type: "host:register",
        hostId: "host",
        worktrees: [],
        protocolVersion: 7,
      }),
    ).resolves.toEqual({
      ok: false,
      error: "hostId host already has an active connection",
    });
  });

  it("requeues omitted in-memory sessions from a keepalive before listing handoffs", async () => {
    const state = createControlPlaneState({ now: () => NOW, idFactory: () => "handoff" });
    expect(
      handleHostMessage(state, {
        type: "host:register",
        hostId: "host",
        worktrees: [],
        protocolVersion: 7,
      }),
    ).toEqual({ ok: true });
    state.sessions.set(
      "session",
      running({ ackReceivedAt: NOW, primaryCommandStartState: "pending" }),
    );
    state.worktrees.set("worktree", busyWorktree());

    await expect(
      handleHostMessageDurable(state, {
        type: "host:keepalive",
        hostId: "host",
        at: NOW,
        runningSessions: [],
      }),
    ).resolves.toEqual({ ok: true });
    expect(state.sessions.get("session")?.status).toBe("queued");
  });

  it("does not list handoffs for a disconnected local keepalive", async () => {
    const state = createControlPlaneState({ now: () => NOW });
    state.sessions.set("session", pendingHandoff());

    await expect(
      handleHostMessageDurable(state, {
        type: "host:keepalive",
        hostId: "host",
        at: NOW,
      }),
    ).resolves.toEqual({ ok: false, error: "agent not connected" });
  });

  it("registers a storage-less host without listing empty recovery handoffs", async () => {
    const state = createControlPlaneState({ now: () => NOW });

    await expect(
      handleHostMessageDurable(state, {
        type: "host:register",
        hostId: "host",
        worktrees: [],
        protocolVersion: 7,
        runningAttempts: [],
      }),
    ).resolves.toEqual({
      ok: true,
      connectionId: expect.any(String),
    });
  });

  it("does not requeue a still-reported in-memory session on keepalive", async () => {
    const state = createControlPlaneState({ now: () => NOW });
    expect(
      handleHostMessage(state, {
        type: "host:register",
        hostId: "host",
        worktrees: [],
        protocolVersion: 7,
      }),
    ).toEqual({ ok: true });
    state.sessions.set("session", pendingHandoff());

    await expect(
      handleHostMessageDurable(state, {
        type: "host:keepalive",
        hostId: "host",
        at: NOW,
        runningSessions: ["session"],
      }),
    ).resolves.toMatchObject({
      ok: true,
      terminalHookHandoffs: [expect.objectContaining({ handoffId: "handoff" })],
    });
    expect(state.sessions.get("session")?.status).toBe("failed");
  });

  it("returns a storage-less keepalive without handoffs when none are pending", async () => {
    const state = createControlPlaneState({ now: () => NOW });
    expect(
      handleHostMessage(state, {
        type: "host:register",
        hostId: "host",
        worktrees: [],
        protocolVersion: 7,
      }),
    ).toEqual({ ok: true });

    await expect(
      handleHostMessageDurable(state, {
        type: "host:keepalive",
        hostId: "host",
        at: NOW,
      }),
    ).resolves.toEqual({ ok: true });
  });

  it("defers omitted-session reconcile until registerHostDurable awaits it", async () => {
    const state = createControlPlaneState({
      now: () => NOW,
      connectionIdFactory: () => "conn",
    });
    expect(
      registerHost(state, {
        hostId: "host",
        worktrees: [],
        deferRunningSessionReconcile: true,
      }),
    ).toEqual({ ok: true, connectionId: "conn" });
    await expect(
      registerHostDurable(state, {
        hostId: "host",
        worktrees: [],
        replaceExisting: true,
      }),
    ).resolves.toMatchObject({ ok: true });
  });
});
