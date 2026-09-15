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
  it("processes a structured result from a connection reporting an old sourceProtocolVersion", async () => {
    // The control plane no longer tracks a graduated per-feature protocol
    // floor: every live host connection negotiated exactly
    // HOST_PROTOCOL_VERSION (see modules/shared/src/constants.ts), so a
    // `sourceProtocolVersion` argument below that is not a "legacy daemon"
    // that can still be connected — it can only be stale/unset transport
    // metadata, and must not gate reading or acknowledging the report.
    const state = createControlPlaneState({ now: () => NOW });
    const getSession = vi.fn(async () => resolvedSession());
    setDurableReadStorage(state, { getSession, getHostLock: async () => "legacy-connection" });

    await expect(
      handleHostMessageDurable(
        state,
        { ...deferredStatus(), result: { summary: "done" } },
        "legacy-connection",
        false,
        false,
        2,
      ),
    ).resolves.toEqual({
      ok: true,
      terminalHookHandoffId: "handoff",
      terminalHookHandoffExpiresAt: "2026-01-02T00:00:00.000Z",
      sessionStatusAcknowledged: {
        sessionId: "session",
        attemptId: "attempt",
        terminalHookHandoffId: "handoff",
        terminalHookHandoffExpiresAt: "2026-01-02T00:00:00.000Z",
      },
    });
    expect(getSession).toHaveBeenCalled();
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

  it("replays a matching handoff ID with its expiry regardless of the reported sourceProtocolVersion", async () => {
    // The expiry used to be withheld below TERMINAL_HOOK_HANDOFF_EXPIRY_PROTOCOL_VERSION;
    // that graduated gate is gone (every negotiated host connection is exactly
    // HOST_PROTOCOL_VERSION), so a stale `sourceProtocolVersion` argument (6)
    // must not change the replayed ack shape.
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
      terminalHookHandoffExpiresAt: "2026-01-02T00:00:00.000Z",
      sessionStatusAcknowledged: {
        sessionId: "session",
        attemptId: "attempt",
        terminalHookHandoffId: "handoff",
        terminalHookHandoffExpiresAt: "2026-01-02T00:00:00.000Z",
      },
    });
  });
});
