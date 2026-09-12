import { describe, expect, it } from "vitest";

import { finishHostLostSession } from "./control-plane-infrastructure-retry.ts";
import { handleHostMessage, handleHostMessageDurable } from "./control-plane-messages.ts";
import { createControlPlaneState } from "./control-plane-state.ts";
import type { SessionRecord } from "./db/types.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function running(): SessionRecord {
  return {
    id: "session",
    repositoryId: "repo",
    prompt: "run",
    target: { commandId: "cmd" },
    fallbacks: [],
    targetDisplayNames: ["cmd"],
    queueTtlSeconds: 3600,
    queueExpiresAt: "2026-01-01T01:00:00.000Z",
    timeout: 30,
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
  };
}

function connectedState() {
  const state = createControlPlaneState({ now: () => NOW, idFactory: () => "handoff" });
  state.hostConnection.set("host", "connection");
  state.connections.set("connection", {
    type: "host",
    hostId: "host",
    connectionId: "connection",
    connectedAt: NOW,
    lastHeartbeatAt: NOW,
    repositoryIds: ["repo"],
    capabilities: [],
    protocolVersion: 6,
  });
  return state;
}

describe("terminal hook results", () => {
  it("stores a normalized post-hook result on the in-memory completion path", async () => {
    const state = connectedState();
    const finished = finishHostLostSession(state, running());
    state.sessions.set(finished.id, finished);

    expect(
      handleHostMessage(
        state,
        {
          type: "session:terminal-hook-complete",
          sessionId: "session",
          handoffId: "handoff",
          result: { summary: "x".repeat(5_000), summarySource: "harness" },
        },
        "connection",
      ),
    ).toEqual({ ok: true });
    await Promise.resolve();
    expect(state.sessions.get("session")?.result).toMatchObject({
      summarySource: "harness",
      summaryTruncated: true,
    });

    const second = connectedState();
    second.sessions.set(finished.id, finishHostLostSession(second, running()));
    expect(
      handleHostMessage(second, {
        type: "session:terminal-hook-complete",
        sessionId: "session",
        handoffId: "handoff",
        result: { summary: "", summarySource: "harness" },
      }),
    ).toEqual({ ok: false, error: "invalid session result" });
  });

  it("replays the durable handoff id when a terminal status acknowledgement was lost", async () => {
    const state = connectedState();
    const session = {
      ...running(),
      status: "failed" as const,
      completedAt: NOW,
      terminalHookHandoff: {
        handoffId: "handoff",
        hostId: "host",
        repositoryId: "repo",
        worktreeId: "worktree",
        status: "failed" as const,
        errorCode: "checkout_fetch_failed" as const,
        expiresAt: "2026-01-02T00:00:00.000Z",
      },
    };
    state.sessions.set(session.id, session);
    state.storage = { getSession: async () => state.sessions.get("session") ?? null } as never;

    await expect(
      handleHostMessageDurable(state, {
        type: "session:status",
        sessionId: "session",
        worktreeId: "worktree",
        attemptId: "attempt",
        status: "failed",
        errorCode: "checkout_fetch_failed",
        deferTerminalHookResult: true,
      }),
    ).resolves.toMatchObject({
      sessionStatusAcknowledged: {
        retryAccepted: false,
        terminalHookHandoffId: "handoff",
      },
    });
  });
});
