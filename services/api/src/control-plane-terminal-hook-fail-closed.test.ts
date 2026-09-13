import { describe, expect, it } from "vitest";

import { handleHostMessage, handleHostMessageDurable } from "./control-plane-messages.ts";
import { createControlPlaneState } from "./control-plane-state.ts";
import { settleTerminalHookHandoff } from "./control-plane-terminal-hook-handoff.ts";
import type { SessionRecord } from "./db/types.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function failedHandoff(over: Partial<SessionRecord> = {}): SessionRecord {
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
    status: "failed",
    queueShard: 0,
    createdAt: NOW,
    hostId: "host",
    worktreeId: "worktree",
    attemptId: "attempt",
    activeHostId: "host",
    activeHostOrder: `${NOW}#session`,
    terminalHookHandoff: {
      handoffId: "handoff",
      hostId: "host",
      repositoryId: "repo",
      worktreeId: "worktree",
      status: "failed",
      errorCode: "checkout_fetch_failed",
      expiresAt: "2026-01-02T00:00:00.000Z",
    },
    ...over,
  };
}

function connectedState(protocolVersion: number) {
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
    protocolVersion,
    negotiatedProtocolVersion: protocolVersion,
  });
  return state;
}

describe("terminal hook fail-closed result settlement", () => {
  it("persists a harness fallback for a protocol-v6 completion that omitted a result", async () => {
    const state = connectedState(6);
    state.sessions.set("session", failedHandoff());
    await expect(
      settleTerminalHookHandoff(state, {
        sessionId: "session",
        handoffId: "handoff",
        hostId: "host",
        connectionId: "connection",
      }),
    ).resolves.toBe(true);
    expect(state.sessions.get("session")?.result).toEqual({
      summary: "Session failed",
      summarySource: "harness",
    });
  });

  it("keeps protocol-v5 host-loss completions result-less", async () => {
    const state = connectedState(5);
    state.sessions.set("session", failedHandoff());
    expect(
      handleHostMessage(
        state,
        { type: "session:terminal-hook-complete", sessionId: "session", handoffId: "handoff" },
        "connection",
      ),
    ).toEqual({ ok: true });
    await Promise.resolve();
    expect(state.sessions.get("session")).not.toHaveProperty("result");
    expect(state.sessions.get("session")?.terminalHookHandoffSettled).toEqual({
      handoffId: "handoff",
      hostId: "host",
    });
  });

  it("preserves the first committed result across duplicate completions", async () => {
    const state = connectedState(6);
    state.sessions.set("session", failedHandoff());
    const first = { summary: "first", summarySource: "harness" as const };
    const second = { summary: "second", summarySource: "agent" as const };
    expect(
      handleHostMessage(
        state,
        {
          type: "session:terminal-hook-complete",
          sessionId: "session",
          handoffId: "handoff",
          result: first,
        },
        "connection",
      ),
    ).toEqual({ ok: true });
    await Promise.resolve();
    expect(
      handleHostMessage(
        state,
        {
          type: "session:terminal-hook-complete",
          sessionId: "session",
          handoffId: "handoff",
          result: second,
        },
        "connection",
      ),
    ).toEqual({ ok: true });
    expect(state.sessions.get("session")?.result).toEqual(first);
  });

  it("does not let a durable duplicate replace the first committed result", async () => {
    const state = connectedState(7);
    const row = failedHandoff();
    state.sessions.set("session", row);
    const results: unknown[] = [];
    state.storage = {
      getSession: async () => state.sessions.get("session") ?? null,
      getHostLock: async () => "connection",
      settleTerminalHookHandoff: async (input: { result?: unknown }) => {
        const current = state.sessions.get("session")!;
        if (!current.terminalHookHandoff) {
          return (
            current.terminalHookHandoffSettled?.handoffId === "handoff" &&
            current.terminalHookHandoffSettled.hostId === "host"
          );
        }
        if (input.result && current.result === undefined) current.result = input.result as never;
        delete current.terminalHookHandoff;
        current.terminalHookHandoffSettled = { handoffId: "handoff", hostId: "host" };
        results.push(current.result);
        return true;
      },
    } as never;
    await expect(
      handleHostMessageDurable(
        state,
        {
          type: "session:terminal-hook-complete",
          sessionId: "session",
          handoffId: "handoff",
          result: { summary: "first", summarySource: "harness" },
        },
        "connection",
      ),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      handleHostMessageDurable(
        state,
        {
          type: "session:terminal-hook-complete",
          sessionId: "session",
          handoffId: "handoff",
          result: { summary: "second", summarySource: "agent" },
        },
        "connection",
      ),
    ).resolves.toMatchObject({ ok: true });
    expect(state.sessions.get("session")?.result).toEqual({
      summary: "first",
      summarySource: "harness",
    });
    expect(results).toEqual([{ summary: "first", summarySource: "harness" }]);
  });
});
