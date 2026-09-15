import { describe, expect, it } from "vitest";

import { handleHostMessage } from "./control-plane-messages.ts";
import { createControlPlaneState } from "./control-plane-state.ts";
import type { SessionRecord } from "./db/types.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const EXPIRES = "2026-01-02T00:00:00.000Z";
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
    ...overrides,
  };
}

function v7State(protocolVersion = 7, hostId = "host") {
  const deliveries: unknown[] = [];
  const state = createControlPlaneState({
    now: () => NOW,
    idFactory: () => "handoff",
    onHostMessage: (_id, message) => deliveries.push(message),
  });
  state.hostConnection.set("host", "connection");
  state.connections.set("connection", {
    type: "host",
    hostId,
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

function deferred(extra: Record<string, unknown> = {}) {
  return {
    type: "session:status" as const,
    sessionId: "session",
    worktreeId: "worktree",
    attemptId: "attempt",
    status: "failed" as const,
    errorCode: "checkout_fetch_failed" as const,
    deferTerminalHookResult: true as const,
    ...extra,
  };
}

describe("in-memory late handoff mint fences", () => {
  it("covers expiry, attempt, host, and replay fences", () => {
    const detached = v7State();
    detached.state.sessions.set(
      "session",
      running({ status: "timed_out", hostId: null, worktreeId: null }),
    );
    expect(handleHostMessage(detached.state, deferred(), "connection")).toEqual({ ok: true });
    expect(detached.deliveries).toContainEqual(
      expect.objectContaining({ terminalHookHandoffId: "handoff", retryAccepted: false }),
    );

    const expired = v7State();
    expired.state.sessions.set(
      "session",
      running({ status: "cancelled", terminalHookHandoffExpiredAt: EXPIRES, worktreeId: null }),
    );
    expect(handleHostMessage(expired.state, deferred(), "connection")).toEqual({ ok: true });
    expect(expired.state.sessions.get("session")?.terminalHookHandoff).toBeUndefined();

    const stale = v7State();
    stale.state.sessions.set("session", running({ status: "cancelled", attemptId: "other" }));
    expect(handleHostMessage(stale.state, deferred(), "connection")).toEqual({ ok: true });
    expect(stale.state.sessions.get("session")?.terminalHookHandoff).toBeUndefined();

    const live = v7State();
    live.state.sessions.set("session", running({ status: "cancelled" }));
    expect(handleHostMessage(live.state, deferred({ status: "running" }), "connection")).toEqual({
      ok: true,
    });
    expect(live.state.sessions.get("session")?.terminalHookHandoff).toBeUndefined();

    const emptyHost = v7State(7, "");
    emptyHost.state.sessions.set(
      "session",
      running({ status: "cancelled", hostId: null, worktreeId: null }),
    );
    expect(handleHostMessage(emptyHost.state, deferred(), "connection")).toEqual({ ok: true });
    expect(emptyHost.state.sessions.get("session")?.terminalHookHandoff).toBeUndefined();

    const mismatch = v7State();
    mismatch.state.sessions.set(
      "session",
      running({ status: "cancelled", terminalHookHandoff: { ...HANDOFF, status: "cancelled" } }),
    );
    expect(handleHostMessage(mismatch.state, deferred(), "connection")).toEqual({ ok: true });
    expect(mismatch.deliveries).not.toContainEqual(
      expect.objectContaining({ terminalHookHandoffId: "handoff" }),
    );

    const replay = v7State();
    replay.state.sessions.set(
      "session",
      running({
        status: "cancelled",
        infrastructureRetryAttemptId: "attempt",
        terminalHookHandoff: { ...HANDOFF, status: "failed", errorCode: "checkout_fetch_failed" },
      }),
    );
    expect(handleHostMessage(replay.state, deferred())).toEqual({ ok: true });
    expect(replay.deliveries).toContainEqual(
      expect.objectContaining({ retryAccepted: true, terminalHookHandoffId: "handoff" }),
    );

    const noRetryAttemptReplay = v7State();
    noRetryAttemptReplay.state.sessions.set(
      "session",
      running({ status: "cancelled", terminalHookHandoff: { ...HANDOFF, status: "failed" } }),
    );
    expect(handleHostMessage(noRetryAttemptReplay.state, deferred(), "connection")).toEqual({
      ok: true,
    });
    expect(noRetryAttemptReplay.deliveries).toContainEqual({
      type: "session:status-acknowledged",
      sessionId: "session",
      attemptId: "attempt",
      retryAccepted: false,
      terminalHookHandoffId: "handoff",
      terminalHookHandoffExpiresAt: EXPIRES,
    });

    const genericReplay = v7State();
    genericReplay.state.sessions.set(
      "session",
      running({
        status: "cancelled",
        terminalHookHandoff: { ...HANDOFF, status: "failed", errorCode: "setup_failed" },
      }),
    );
    expect(
      handleHostMessage(genericReplay.state, deferred({ errorCode: "setup_failed" }), "connection"),
    ).toEqual({ ok: true });
    expect(genericReplay.deliveries).toContainEqual({
      type: "session:status-acknowledged",
      sessionId: "session",
      attemptId: "attempt",
      terminalHookHandoffId: "handoff",
      terminalHookHandoffExpiresAt: EXPIRES,
    });

    const orphanReplay = v7State();
    orphanReplay.state.sessions.set(
      "session",
      running({
        status: "cancelled",
        hostId: null,
        terminalHookHandoff: { ...HANDOFF, status: "failed" },
      }),
    );
    expect(handleHostMessage(orphanReplay.state, deferred())).toEqual({ ok: true });
    expect(orphanReplay.state.sessions.get("session")?.terminalHookHandoff?.handoffId).toBe(
      "handoff",
    );
  });
});
