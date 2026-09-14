import { describe, expect, it, vi } from "vitest";

import { getArchive } from "./control-plane-archive.ts";
import { handleHostMessage } from "./control-plane-messages.ts";
import { createControlPlaneState } from "./control-plane-state.ts";
import type { SessionRecord, WorktreeRecord } from "./db/types.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const EXPIRES = "2026-01-02T00:00:00.000Z";
const RESULT = {
  summary: "post-hook branch",
  summarySource: "agent" as const,
  branch: "auto-harness/session",
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
    timeout: 60,
    priority: 0,
    requiredLabels: [],
    status: "running",
    queueShard: 0,
    createdAt: NOW,
    hostId: "host",
    worktreeId: "worktree",
    attemptId: "attempt",
    infrastructureRetryCount: 1,
    ...overrides,
  };
}

function v7State(protocolVersion = 7) {
  const deliveries: unknown[] = [];
  const state = createControlPlaneState({
    now: () => NOW,
    idFactory: () => "handoff",
    onHostMessage: (_id, message) => deliveries.push(message),
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

function exhaustedFailure() {
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

describe("in-memory exhausted checkout handoff", () => {
  it("hands off the post-hook result before archival", async () => {
    const { state, deliveries } = v7State();
    state.sessions.set("session", running());
    state.worktrees.set("worktree", {
      id: "worktree",
      hostId: "host",
      repositoryId: "repo",
      status: "busy",
      currentSessionId: "session",
    } as WorktreeRecord);

    expect(handleHostMessage(state, exhaustedFailure(), "connection")).toEqual({ ok: true });
    expect(deliveries).toContainEqual({
      type: "session:status-acknowledged",
      sessionId: "session",
      attemptId: "attempt",
      retryAccepted: false,
      terminalHookHandoffId: "handoff",
      terminalHookHandoffExpiresAt: EXPIRES,
    });
    expect(state.sessions.get("session")).toMatchObject({
      status: "failed",
      errorCode: "checkout_fetch_failed",
      terminalHookHandoff: { handoffId: "handoff", worktreeId: "worktree" },
    });
    expect(state.sessions.get("session")).not.toHaveProperty("result");
    expect(getArchive(state, "session")).toBeNull();

    expect(handleHostMessage(state, exhaustedFailure(), "connection")).toEqual({ ok: true });
    expect(
      deliveries.filter(
        (message) => (message as { type?: string }).type === "session:status-acknowledged",
      ),
    ).toHaveLength(2);

    expect(
      handleHostMessage(
        state,
        {
          type: "session:terminal-hook-complete",
          sessionId: "session",
          handoffId: "handoff",
          result: RESULT,
        },
        "connection",
      ),
    ).toEqual({ ok: true });
    await vi.waitFor(() => expect(state.sessions.get("session")?.result).toEqual(RESULT));
    expect(
      handleHostMessage(
        state,
        {
          type: "session:terminal-hook-complete",
          sessionId: "session",
          handoffId: "handoff",
          result: { summary: "duplicate", summarySource: "harness" },
        },
        "connection",
      ),
    ).toEqual({ ok: true });
    await Promise.all(state.pendingPersists);
    expect(state.sessions.get("session")?.result).toEqual(RESULT);
    expect(state.sessions.get("session")).toMatchObject({
      terminalHookHandoffSettled: { handoffId: "handoff", hostId: "host" },
    });
    expect(state.sessions.get("session")).not.toHaveProperty("terminalHookHandoff");
    expect(getArchive(state, "session")).toMatchObject({ status: "pending" });
  });

  it("archives immediately when a v7 handoff cannot be minted", () => {
    const legacy = v7State(6);
    legacy.state.sessions.set("session", running());
    expect(handleHostMessage(legacy.state, exhaustedFailure(), "connection")).toEqual({ ok: true });
    expect(legacy.deliveries).toContainEqual({
      type: "session:status-acknowledged",
      sessionId: "session",
      attemptId: "attempt",
    });
    expect(legacy.state.sessions.get("session")?.terminalHookHandoff).toBeUndefined();
    expect(legacy.state.pendingPersists).toHaveLength(1);

    const emptyHost = v7State();
    emptyHost.state.connections.get("connection")!.hostId = "";
    emptyHost.state.sessions.set("session", running({ hostId: null }));
    expect(handleHostMessage(emptyHost.state, exhaustedFailure(), "connection")).toEqual({
      ok: true,
    });
    expect(emptyHost.state.sessions.get("session")?.terminalHookHandoff).toBeUndefined();
    expect(emptyHost.state.pendingPersists).toHaveLength(1);

    const completed = v7State();
    completed.state.sessions.set("session", running({ infrastructureRetryCount: 0 }));
    expect(
      handleHostMessage(
        completed.state,
        {
          type: "session:status",
          sessionId: "session",
          worktreeId: "worktree",
          attemptId: "attempt",
          status: "completed",
          exitCode: 0,
        },
        "connection",
      ),
    ).toEqual({ ok: true });
    expect(completed.state.sessions.get("session")?.terminalHookHandoff).toBeUndefined();
    expect(completed.state.pendingPersists).toHaveLength(1);
  });
});
