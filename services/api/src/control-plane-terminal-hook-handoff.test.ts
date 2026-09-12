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
  it("delivers only to a v5 replacement and clears its active index after settlement", async () => {
    const state = connectedState(5);
    const finished = finishHostLostSession(state, running());
    state.sessions.set(finished.id, finished);

    await expect(pendingTerminalHookHandoffs(state, "host")).resolves.toEqual([
      expect.objectContaining({
        type: "session:terminal-hook",
        handoffId: "handoff",
        worktreeId: "worktree",
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
  });

  it("withholds a handoff from v4 and expires it before a later v5 registration", async () => {
    const state = connectedState(4, "2026-01-02T00:00:00.001Z");
    const finished = finishHostLostSession(
      createControlPlaneState({ now: () => NOW, idFactory: () => "handoff" }),
      running(),
    );
    state.sessions.set(finished.id, finished);

    await expect(pendingTerminalHookHandoffs(state, "host")).resolves.toEqual([]);
    state.connections.get("connection")!.protocolVersion = 5;
    await expect(pendingTerminalHookHandoffs(state, "host")).resolves.toEqual([]);
    expect(state.sessions.get("session")?.terminalHookHandoffExpiredAt).toBe(
      "2026-01-02T00:00:00.000Z",
    );
  });

  it("fences settlement to the replacement connection and acknowledges an idempotent duplicate", async () => {
    const state = connectedState(5);
    const finished = finishHostLostSession(state, running());
    state.sessions.set(finished.id, finished);
    let settled = 0;
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
    } as never;

    const completion = {
      type: "session:terminal-hook-complete" as const,
      sessionId: "session",
      handoffId: "handoff",
    };
    await expect(handleHostMessageDurable(state, completion, "stale")).resolves.toMatchObject({
      ok: false,
      error: "stale host connection",
    });
    await expect(handleHostMessageDurable(state, completion, "current")).resolves.toMatchObject({
      ok: true,
      sessionTerminalHookAcknowledged: { sessionId: "session", handoffId: "handoff" },
    });
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
