import { describe, expect, it } from "vitest";

import { finishHostLostSession } from "./control-plane-infrastructure-retry.ts";
import { createControlPlaneState } from "./control-plane-state.ts";
import { handleHostMessageDurable } from "./control-plane-messages.ts";
import {
  pendingTerminalHookHandoffs,
  settleTerminalHookHandoff,
} from "./control-plane-terminal-hook-handoff.ts";
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

function connectedState(protocolVersion: number, now = NOW) {
  const state = createControlPlaneState({ now: () => now, idFactory: () => "handoff" });
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
  });
  return state;
}

describe("terminal hook handoff", () => {
  it("delivers only to a v7 replacement with the durable absolute expiry", async () => {
    const state = connectedState(7);
    const finished = finishHostLostSession(state, running());
    state.sessions.set(finished.id, finished);
    state.worktrees.set("worktree", {
      id: "worktree",
      hostId: "host",
      repositoryId: "repo",
      status: "busy",
      currentSessionId: "session",
    } as never);

    await expect(pendingTerminalHookHandoffs(state, "host")).resolves.toEqual([
      expect.objectContaining({
        type: "session:terminal-hook",
        handoffId: "handoff",
        worktreeId: "worktree",
        expiresAt: "2026-01-02T00:00:00.000Z",
        errorCode: "host_lost",
      }),
    ]);

    await expect(
      settleTerminalHookHandoff(state, {
        sessionId: "session",
        handoffId: "handoff",
        hostId: "host",
        connectionId: "connection",
      }),
    ).resolves.toBe(true);
    expect(state.sessions.get("session")).toEqual(
      expect.not.objectContaining({ terminalHookHandoff: expect.anything(), activeHostId: "host" }),
    );
    expect(state.worktrees.get("worktree")).toMatchObject({
      status: "idle",
      currentSessionId: null,
    });
  });

  it("keeps a main-checkout lease reserved through handoff, then releases it locally", async () => {
    const state = connectedState(7);
    const finished = finishHostLostSession(state, {
      ...running(),
      worktreeId: null,
      mainCheckoutLease: true,
      assignmentConnectionId: "connection",
    });
    state.sessions.set(finished.id, finished);
    state.mainCheckoutLeases.set("host\0repo", {
      sessionId: "session",
      connectionId: "connection",
    });

    expect(finished.terminalHookHandoff?.mainCheckoutLease).toBe(true);
    expect(state.mainCheckoutLeases.get("host\0repo")?.sessionId).toBe("session");
    await expect(
      settleTerminalHookHandoff(state, {
        sessionId: "session",
        handoffId: "handoff",
        hostId: "host",
        connectionId: "connection",
      }),
    ).resolves.toBe(true);
    expect(state.mainCheckoutLeases.has("host\0repo")).toBe(false);
    expect(state.sessions.get("session")).not.toHaveProperty("mainCheckoutLease");
  });

  it("withholds a handoff from v6 and expires it before a later v7 registration", async () => {
    const state = connectedState(6, "2026-01-02T00:00:00.001Z");
    const finished = finishHostLostSession(
      createControlPlaneState({ now: () => NOW, idFactory: () => "handoff" }),
      running(),
    );
    state.sessions.set(finished.id, finished);
    state.worktrees.set("worktree", {
      id: "worktree",
      hostId: "host",
      repositoryId: "repo",
      status: "busy",
      currentSessionId: "session",
    } as never);

    await expect(pendingTerminalHookHandoffs(state, "host")).resolves.toEqual([]);
    state.connections.get("connection")!.protocolVersion = 7;
    await expect(pendingTerminalHookHandoffs(state, "host")).resolves.toEqual([]);
    expect(state.sessions.get("session")?.terminalHookHandoffExpiredAt).toBe(
      "2026-01-02T00:00:00.000Z",
    );
    expect(state.worktrees.get("worktree")).toMatchObject({
      status: "idle",
      currentSessionId: null,
    });
  });

  it("fences settlement to the replacement connection and acknowledges an idempotent duplicate", async () => {
    const state = connectedState(7);
    const finished = finishHostLostSession(state, running());
    state.sessions.set(finished.id, finished);
    let settled = 0;
    const archivedResults: unknown[] = [];
    state.storage = {
      getSession: async () => state.sessions.get("session") ?? null,
      getHostLock: async () => "current",
      settleTerminalHookHandoff: async () => {
        settled += 1;
        const current = state.sessions.get("session")!;
        delete current.terminalHookHandoff;
        delete current.activeHostId;
        delete current.activeHostOrder;
        current.terminalHookHandoffSettled = { handoffId: "handoff", hostId: "host" };
        return true;
      },
      putArchive: async () => void archivedResults.push(state.sessions.get("session")?.result),
      listLogs: async () => [],
    } as never;

    const completion = {
      type: "session:terminal-hook-complete" as const,
      sessionId: "session",
      handoffId: "handoff",
      result: { summary: "post-hook", summarySource: "harness" as const },
    };
    await expect(
      handleHostMessageDurable(
        state,
        { ...completion, result: { summary: "", summarySource: "harness" } },
        "current",
      ),
    ).resolves.toEqual({ ok: false, error: "invalid session result" });
    await expect(handleHostMessageDurable(state, completion, "stale")).resolves.toMatchObject({
      ok: false,
      error: "stale host connection",
    });
    await expect(handleHostMessageDurable(state, completion, "current")).resolves.toMatchObject({
      ok: true,
      sessionTerminalHookAcknowledged: { sessionId: "session", handoffId: "handoff" },
    });
    await Promise.all(state.pendingPersists);
    expect(state.sessions.get("session")?.result).toEqual({
      summary: "post-hook",
      summarySource: "harness",
    });
    expect(archivedResults).toEqual([{ summary: "post-hook", summarySource: "harness" }]);
    await expect(
      handleHostMessageDurable(state, { ...completion, handoffId: "other" }, "current"),
    ).resolves.toMatchObject({ ok: false, error: "terminal hook handoff not found" });
    await expect(handleHostMessageDurable(state, completion, "current")).resolves.toMatchObject({
      ok: true,
      sessionTerminalHookAcknowledged: { sessionId: "session", handoffId: "handoff" },
    });
    expect(settled).toBe(1);
  });
});
