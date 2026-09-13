import { describe, expect, it, vi } from "vitest";

import { setDurableReadStorage } from "../test-helpers/control-plane-durable-read-test-helpers.ts";
import { handleHostMessageDurable } from "./control-plane-messages.ts";
import { createControlPlaneState } from "./control-plane-state.ts";
import type { SessionRecord } from "./db/types.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function resolvedSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
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
    status: "failed",
    queueShard: 0,
    createdAt: NOW,
    hostId: "reporting-host",
    worktreeId: null,
    attemptId: "attempt",
    terminalHookHandoff: {
      handoffId: "handoff",
      attemptId: "attempt",
      hostId: "reporting-host",
      repositoryId: "repo",
      worktreeId: "worktree",
      status: "failed",
      expiresAt: "2026-01-02T00:00:00.000Z",
    },
    ...overrides,
  };
}

function deferredStatus(status: "completed" | "failed" = "failed") {
  return {
    type: "session:status" as const,
    sessionId: "session",
    worktreeId: "worktree",
    attemptId: "attempt",
    status,
    deferTerminalHookResult: true as const,
  };
}

describe("durable host message preconditions and handoff replay ownership", () => {
  it("rejects a structured result before reading or mutating a legacy connection's session", async () => {
    const state = createControlPlaneState({ now: () => NOW });
    const getSession = vi.fn(async () => resolvedSession());
    setDurableReadStorage(state, { getSession });

    await expect(
      handleHostMessageDurable(
        state,
        { ...deferredStatus(), result: { summary: "done" } },
        "legacy-connection",
        false,
        false,
        2,
      ),
    ).resolves.toEqual({ ok: false, error: "session result requires host protocol 3" });
    expect(getSession).not.toHaveBeenCalled();
    expect(state.sessions).toHaveLength(0);
  });

  it("acknowledges but does not replay a matching-attempt handoff to a different host", async () => {
    const state = createControlPlaneState({ now: () => NOW });
    const session = resolvedSession({
      terminalHookHandoff: {
        ...resolvedSession().terminalHookHandoff!,
        hostId: "handoff-owner",
      },
    });
    setDurableReadStorage(state, {
      getSession: async () => session,
      getHostLock: async () => "reporting-connection",
    });

    await expect(
      handleHostMessageDurable(state, deferredStatus(), "reporting-connection", false, false, 7),
    ).resolves.toEqual({
      ok: true,
      sessionStatusAcknowledged: { sessionId: "session", attemptId: "attempt" },
    });
  });

  it("acknowledges but does not replay a handoff for a different terminal status", async () => {
    const state = createControlPlaneState({ now: () => NOW });
    const session = resolvedSession();
    setDurableReadStorage(state, {
      getSession: async () => session,
      getHostLock: async () => "reporting-connection",
    });

    await expect(
      handleHostMessageDurable(
        state,
        deferredStatus("completed"),
        "reporting-connection",
        false,
        false,
        7,
      ),
    ).resolves.toEqual({
      ok: true,
      sessionStatusAcknowledged: { sessionId: "session", attemptId: "attempt" },
    });
  });

  it("acknowledges a resolved terminal report after its handoff has been cleared", async () => {
    const state = createControlPlaneState({ now: () => NOW });
    const session = resolvedSession({ terminalHookHandoff: undefined });
    setDurableReadStorage(state, {
      getSession: async () => session,
      getHostLock: async () => "reporting-connection",
    });

    await expect(
      handleHostMessageDurable(state, deferredStatus(), "reporting-connection", false, false, 7),
    ).resolves.toEqual({
      ok: true,
      sessionStatusAcknowledged: { sessionId: "session", attemptId: "attempt" },
    });
  });

  it("acknowledges a resolved terminal report without replaying a replacement attempt's handoff", async () => {
    const state = createControlPlaneState({ now: () => NOW });
    const session = resolvedSession({
      terminalHookHandoff: {
        ...resolvedSession().terminalHookHandoff!,
        attemptId: "replacement-attempt",
      },
    });
    setDurableReadStorage(state, {
      getSession: async () => session,
      getHostLock: async () => "reporting-connection",
    });

    await expect(
      handleHostMessageDurable(state, deferredStatus(), "reporting-connection", false, false, 7),
    ).resolves.toEqual({
      ok: true,
      sessionStatusAcknowledged: { sessionId: "session", attemptId: "attempt" },
    });
  });

  it("replays a matching handoff ID but withholds its expiry from a legacy daemon", async () => {
    const state = createControlPlaneState({ now: () => NOW });
    const session = resolvedSession();
    setDurableReadStorage(state, {
      getSession: async () => session,
      getHostLock: async () => "reporting-connection",
    });

    await expect(
      handleHostMessageDurable(state, deferredStatus(), "reporting-connection", false, false, 6),
    ).resolves.toEqual({
      ok: true,
      terminalHookHandoffId: "handoff",
      sessionStatusAcknowledged: {
        sessionId: "session",
        attemptId: "attempt",
        terminalHookHandoffId: "handoff",
      },
    });
  });
});
