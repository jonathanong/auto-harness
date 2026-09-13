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
const HANDOFF = {
  handoffId: "handoff",
  attemptId: "attempt",
  hostId: "host",
  repositoryId: "repo",
  worktreeId: "worktree",
  expiresAt: EXPIRES,
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

function v7State(protocolVersion = 7) {
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
    protocolVersion,
    negotiatedProtocolVersion: protocolVersion,
  });
  return { state, deliveries };
}

function deferredFailure(
  errorCode: "checkout_fetch_failed" | "setup_failed" = "checkout_fetch_failed",
) {
  return {
    type: "session:status" as const,
    sessionId: "session",
    worktreeId: "worktree",
    attemptId: "attempt",
    status: "failed" as const,
    errorCode,
    deferTerminalHookResult: true as const,
  };
}

function expectHandoffAck(deliveries: unknown[], extra: Record<string, unknown> = {}): void {
  expect(deliveries).toContainEqual({
    type: "session:status-acknowledged",
    sessionId: "session",
    attemptId: "attempt",
    terminalHookHandoffId: "handoff",
    terminalHookHandoffExpiresAt: EXPIRES,
    ...extra,
  });
}

async function completeOnce(
  state: ReturnType<typeof createControlPlaneState>,
  deliveries: unknown[],
): Promise<void> {
  expect(handleHostMessage(state, deferredFailure(), "connection")).toEqual({ ok: true });
  expectHandoffAck(deliveries, { retryAccepted: false });
  deliveries.length = 0;
  expect(handleHostMessage(state, deferredFailure(), "connection")).toEqual({ ok: true });
  expectHandoffAck(deliveries, { retryAccepted: false });
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
  expect(handleHostMessage(state, deferredFailure(), "connection")).toEqual({ ok: true });
  expect(state.sessions.get("session")?.terminalHookHandoff).toBeUndefined();
}

describe("in-memory late cancel and timeout handoffs", () => {
  it("preserves a deferred checkout hook when cancellation wins first", async () => {
    const { state, deliveries } = v7State();
    state.sessions.set("session", running());
    state.worktrees.set("worktree", {
      id: "worktree",
      hostId: "host",
      repositoryId: "repo",
      status: "busy",
      currentSessionId: "session",
    } as WorktreeRecord);
    expect(cancelSession(state, "session")).toMatchObject({ ok: true });
    await completeOnce(state, deliveries);
    expect(state.worktrees.get("worktree")).toMatchObject({
      status: "idle",
      currentSessionId: null,
    });
  });

  it("preserves a deferred checkout hook when running timeout wins first", async () => {
    const { state, deliveries } = v7State();
    state.sessions.set(
      "session",
      running({ ackReceivedAt: NOW, assignmentConnectionId: "connection" }),
    );
    expect(enforceRunningTimeouts(state, Date.parse(NOW) + 1000)).toEqual(["session"]);
    expect(state.sessions.get("session")).toMatchObject({
      status: "timed_out",
      timedOutHostId: "host",
    });
    await completeOnce(state, deliveries);
    await Promise.all(state.pendingPersists);
    expect(state.sessions.get("session")?.result).toEqual(RESULT);
  });

  it("covers reporting-host fallback, protocol gating, and handoff replay fences", () => {
    const detached = v7State();
    detached.state.sessions.set(
      "session",
      running({ status: "timed_out", hostId: null, worktreeId: null }),
    );
    expect(handleHostMessage(detached.state, deferredFailure(), "connection")).toEqual({
      ok: true,
    });
    expectHandoffAck(detached.deliveries, { retryAccepted: false });

    const legacy = v7State(6);
    legacy.state.sessions.set("session", running({ status: "cancelled", completedAt: NOW }));
    expect(handleHostMessage(legacy.state, deferredFailure(), "connection")).toEqual({ ok: true });
    expect(legacy.state.sessions.get("session")?.terminalHookHandoff).toBeUndefined();

    const mismatch = v7State();
    mismatch.state.sessions.set(
      "session",
      running({ status: "cancelled", terminalHookHandoff: { ...HANDOFF, status: "cancelled" } }),
    );
    expect(handleHostMessage(mismatch.state, deferredFailure(), "connection")).toEqual({
      ok: true,
    });
    expect(mismatch.deliveries).not.toContainEqual(
      expect.objectContaining({ terminalHookHandoffId: "handoff" }),
    );

    const retry = v7State();
    retry.state.sessions.set(
      "session",
      running({
        status: "cancelled",
        infrastructureRetryAttemptId: "attempt",
        terminalHookHandoff: { ...HANDOFF, status: "failed", errorCode: "checkout_fetch_failed" },
      }),
    );
    expect(handleHostMessage(retry.state, deferredFailure())).toEqual({ ok: true });
    expect(retry.deliveries).toContainEqual(
      expect.objectContaining({ retryAccepted: true, terminalHookHandoffId: "handoff" }),
    );

    const generic = v7State();
    generic.state.sessions.set("session", running({ status: "cancelled", completedAt: NOW }));
    expect(handleHostMessage(generic.state, deferredFailure("setup_failed"), "connection")).toEqual(
      {
        ok: true,
      },
    );
    expectHandoffAck(generic.deliveries);
  });
});
