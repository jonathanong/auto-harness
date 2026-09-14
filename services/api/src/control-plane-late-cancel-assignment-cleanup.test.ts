import { describe, expect, it } from "vitest";

import { handleHostMessage } from "./control-plane-messages.ts";
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
    timeout: 1,
    priority: 0,
    requiredLabels: [],
    status: "cancelled",
    queueShard: 0,
    createdAt: NOW,
    hostId: "host",
    worktreeId: null,
    attemptId: "attempt",
    ...overrides,
  };
}

function v7State() {
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
    protocolVersion: 7,
    negotiatedProtocolVersion: 7,
  });
  return state;
}

function deferred(extra: Record<string, unknown> = {}) {
  return {
    type: "session:status" as const,
    sessionId: "session",
    worktreeId: null,
    attemptId: "attempt",
    status: "failed" as const,
    errorCode: "checkout_fetch_failed" as const,
    deferTerminalHookResult: true as const,
    ...extra,
  };
}

describe("in-memory late cancel assignment cleanup", () => {
  it("releases a cancelled main-checkout lease with the deferred handoff", () => {
    const state = v7State();
    state.sessions.set(
      "session",
      running({ mainCheckoutLease: true, assignmentConnectionId: "connection" }),
    );
    state.mainCheckoutLeases.set("host\0repo", {
      sessionId: "session",
      connectionId: "connection",
    });
    expect(handleHostMessage(state, deferred(), "connection")).toEqual({ ok: true });
    expect(state.sessions.get("session")).toMatchObject({
      terminalHookHandoff: { handoffId: "handoff", mainCheckoutLease: true },
    });
    expect(state.sessions.get("session")).not.toHaveProperty("mainCheckoutLease");
    expect(state.mainCheckoutLeases.size).toBe(0);
  });

  it("releases a cancelled workspace slot, including cleanup errors", () => {
    const state = v7State();
    state.sessions.set("session", running({ workspaceSlotId: "slot", workspacePoolId: "pool" }));
    state.workspaceSlots.set("slot", {
      id: "slot",
      workspacePoolId: "pool",
      hostId: "host",
      status: "busy",
      currentSessionId: "session",
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(
      handleHostMessage(state, deferred({ workspaceSlotError: "cleanup failed" }), "connection"),
    ).toEqual({ ok: true });
    expect(state.workspaceSlots.get("slot")).toMatchObject({
      status: "error",
      currentSessionId: null,
      errorMessage: "cleanup failed",
    });
    expect(state.sessions.get("session")?.workspaceSlotId).toBeNull();

    const idle = v7State();
    idle.sessions.set("session", running({ workspaceSlotId: "slot", workspacePoolId: "pool" }));
    idle.workspaceSlots.set("slot", {
      id: "slot",
      workspacePoolId: "pool",
      hostId: "host",
      status: "busy",
      currentSessionId: "session",
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(handleHostMessage(idle, deferred(), "connection")).toEqual({ ok: true });
    expect(idle.workspaceSlots.get("slot")).toMatchObject({
      status: "idle",
      currentSessionId: null,
    });
  });

  it("does not steal a worktree another session now owns", () => {
    const state = v7State();
    state.sessions.set("session", running({ worktreeId: "worktree" }));
    state.worktrees.set("worktree", {
      id: "worktree",
      hostId: "host",
      repositoryId: "repo",
      status: "busy",
      currentSessionId: "other",
    } as WorktreeRecord);
    expect(
      handleHostMessage(state, { ...deferred(), worktreeId: "worktree" }, "connection"),
    ).toEqual({ ok: true });
    expect(state.worktrees.get("worktree")?.currentSessionId).toBe("other");
    expect(state.sessions.get("session")?.worktreeId).toBeNull();
  });

  it("omits retryAccepted for a late generic deferred hook", () => {
    const state = v7State();
    state.sessions.set("session", running());
    expect(
      handleHostMessage(
        state,
        { ...deferred(), errorCode: "setup_failed", worktreeId: null },
        "connection",
      ),
    ).toEqual({ ok: true });
    expect(state.sessions.get("session")?.terminalHookHandoff).toMatchObject({
      handoffId: "handoff",
      errorCode: "setup_failed",
    });
  });

  it("does not steal a workspace slot or mint over a settled/mismatched host handoff", () => {
    const slot = v7State();
    slot.sessions.set("session", running({ workspaceSlotId: "slot" }));
    slot.workspaceSlots.set("slot", {
      id: "slot",
      workspacePoolId: "pool",
      hostId: "host",
      status: "busy",
      currentSessionId: "other",
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(handleHostMessage(slot, deferred(), "connection")).toEqual({ ok: true });
    expect(slot.workspaceSlots.get("slot")?.currentSessionId).toBe("other");
    expect(slot.sessions.get("session")?.workspaceSlotId).toBeNull();

    const settled = v7State();
    settled.sessions.set(
      "session",
      running({ terminalHookHandoffSettled: { handoffId: "old", hostId: "host" } }),
    );
    expect(handleHostMessage(settled, deferred(), "connection")).toEqual({ ok: true });
    expect(settled.sessions.get("session")?.terminalHookHandoff).toBeUndefined();

    const otherHost = v7State();
    otherHost.sessions.set(
      "session",
      running({
        terminalHookHandoff: {
          handoffId: "handoff",
          attemptId: "attempt",
          hostId: "other",
          repositoryId: "repo",
          worktreeId: null,
          status: "failed",
          expiresAt: "2026-01-02T00:00:00.000Z",
        },
      }),
    );
    const deliveries: unknown[] = [];
    otherHost.onHostMessage = (_id, message) => deliveries.push(message);
    expect(handleHostMessage(otherHost, deferred(), "connection")).toEqual({ ok: true });
    expect(deliveries).not.toContainEqual(
      expect.objectContaining({ terminalHookHandoffId: "handoff" }),
    );
  });
});
