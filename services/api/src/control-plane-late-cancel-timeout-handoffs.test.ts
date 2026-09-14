import { describe, expect, it, vi } from "vitest";

import { cancelSession } from "./control-plane-cancel-local.ts";
import { handleHostMessage } from "./control-plane-messages.ts";
import { enforceRunningTimeouts } from "./control-plane-running-timeout.ts";
import { createControlPlaneState } from "./control-plane-state.ts";
import type { SessionRecord, WorktreeRecord } from "./db/types.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const EXPIRES = "2026-01-02T00:00:00.000Z";
const RESULT = {
  summary: "post-hook branch",
  summarySource: "agent" as const,
  branch: "auto-harness/session",
};
const LEASE = {
  concurrencyId: "provider-lease:account:0",
  providerAccountId: "account",
  slot: 0,
  attemptId: "attempt",
};

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
    timeout: 1,
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

function v7State() {
  const deliveries: unknown[] = [];
  const state = createControlPlaneState({
    now: () => NOW,
    idFactory: () => "handoff",
    onHostMessage: (_hostId, message) => deliveries.push(message),
  });
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
    negotiatedProtocolVersion: 7,
  });
  return { state, deliveries };
}

function deferredFailure() {
  return {
    type: "session:status" as const,
    sessionId: "session",
    worktreeId: "worktree",
    attemptId: "attempt",
    status: "failed" as const,
    errorCode: "checkout_fetch_failed" as const,
    deferTerminalHookResult: true as const,
  };
}

function expectHandoffAck(deliveries: unknown[]): void {
  expect(deliveries).toContainEqual({
    type: "session:status-acknowledged",
    sessionId: "session",
    attemptId: "attempt",
    retryAccepted: false,
    terminalHookHandoffId: "handoff",
    terminalHookHandoffExpiresAt: EXPIRES,
  });
}

async function completeHook(state: ReturnType<typeof createControlPlaneState>): Promise<void> {
  const complete = (result: typeof RESULT | { summary: string; summarySource: "harness" }) =>
    handleHostMessage(
      state,
      {
        type: "session:terminal-hook-complete",
        sessionId: "session",
        handoffId: "handoff",
        result,
      },
      "connection",
    );
  expect(complete(RESULT)).toEqual({ ok: true });
  await vi.waitFor(() => expect(state.sessions.get("session")?.result).toEqual(RESULT));
  expect(complete({ summary: "duplicate", summarySource: "harness" })).toEqual({ ok: true });
  await Promise.resolve();
  expect(state.sessions.get("session")?.result).toEqual(RESULT);
}

describe("in-memory late cancel and timeout handoffs", () => {
  it("releases a cancelled assignment while retaining the deferred hook", async () => {
    const { state, deliveries } = v7State();
    const session = running({ providerAccountLease: LEASE });
    state.sessions.set("session", session);
    state.providerAccountLeases.set(LEASE.concurrencyId, {
      sessionId: "session",
      attemptId: LEASE.attemptId,
      slot: LEASE.slot,
      hostId: "host",
      providerAccountId: LEASE.providerAccountId,
    });
    state.worktrees.set("worktree", {
      id: "worktree",
      hostId: "host",
      repositoryId: "repo",
      status: "busy",
      currentSessionId: "session",
    } as WorktreeRecord);
    expect(cancelSession(state, "session")).toMatchObject({ ok: true });
    expect(handleHostMessage(state, deferredFailure(), "connection")).toEqual({ ok: true });
    expectHandoffAck(deliveries);
    expect(state.worktrees.get("worktree")).toMatchObject({
      status: "idle",
      currentSessionId: null,
    });
    expect(state.providerAccountLeases.size).toBe(0);
    expect(state.sessions.get("session")).toMatchObject({
      worktreeId: null,
      terminalHookHandoff: { handoffId: "handoff" },
    });
    expect(state.sessions.get("session")).not.toHaveProperty("providerAccountLease");
    await completeHook(state);
  });

  it("preserves a deferred checkout hook when running timeout wins first", async () => {
    const { state, deliveries } = v7State();
    state.sessions.set(
      "session",
      running({ ackReceivedAt: NOW, assignmentConnectionId: "connection" }),
    );
    expect(enforceRunningTimeouts(state, Date.parse(NOW) + 1000)).toEqual(["session"]);
    expect(handleHostMessage(state, deferredFailure(), "connection")).toEqual({ ok: true });
    expectHandoffAck(deliveries);
    await completeHook(state);
    await Promise.all(state.pendingPersists);
    expect(state.sessions.get("session")?.result).toEqual(RESULT);
  });

  it("acknowledges an already-accepted checkout retry without minting a handoff", () => {
    const { state, deliveries } = v7State();
    state.sessions.set(
      "session",
      running({
        status: "cancelled",
        hostId: null,
        worktreeId: null,
        infrastructureRetryCount: 1,
        infrastructureRetryAttemptId: "attempt",
      }),
    );
    expect(handleHostMessage(state, deferredFailure(), "connection")).toEqual({ ok: true });
    expect(deliveries).toContainEqual({
      type: "session:status-acknowledged",
      sessionId: "session",
      attemptId: "attempt",
      retryAccepted: true,
    });
    expect(state.sessions.get("session")?.terminalHookHandoff).toBeUndefined();
  });
});
