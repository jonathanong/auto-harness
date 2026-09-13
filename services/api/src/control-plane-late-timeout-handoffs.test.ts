import { describe, expect, it, vi } from "vitest";

import { setDurableReadStorage } from "../test-helpers/control-plane-durable-read-test-helpers.ts";
import { handleHostMessageDurable } from "./control-plane-messages.ts";
import { createControlPlaneState } from "./control-plane-state.ts";
import type { SessionRecord } from "./db/types.ts";

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
    activeHostId: "host",
    activeHostOrder: `${NOW}#session`,
    ...overrides,
  };
}

function deferredStatus(worktreeId: string | null) {
  return {
    type: "session:status" as const,
    sessionId: "session",
    worktreeId,
    attemptId: "attempt",
    status: "failed" as const,
    errorCode: "checkout_fetch_failed" as const,
    deferTerminalHookResult: true as const,
  };
}

describe("durable deferred terminal results", () => {
  it("retains a deferred hook from the detached durable-timeout row without reclaiming its worktree", async () => {
    const state = createControlPlaneState({ now: () => NOW, idFactory: () => "detached-timeout" });
    const session = running({
      status: "timed_out",
      completedAt: NOW,
      hostId: null,
      worktreeId: null,
      timedOutHostId: "host",
      timedOutAssignmentConnectionId: "connection",
      hostAssignmentLease: { hostId: "host", connectionId: "connection", attemptId: "attempt" },
    });
    const finishSession = vi.fn(
      async (input: { terminalHookHandoff?: SessionRecord["terminalHookHandoff"] }) => {
        state.sessions.set(session.id, {
          ...session,
          terminalHookHandoff: input.terminalHookHandoff,
        });
        return true;
      },
    );
    setDurableReadStorage(state, { finishSession, listLogs: async () => [] });
    state.sessions.set(session.id, session);

    await expect(
      handleHostMessageDurable(state, deferredStatus(null), undefined, false, false, 7),
    ).resolves.toMatchObject({
      sessionStatusAcknowledged: {
        terminalHookHandoffId: "detached-timeout",
        terminalHookHandoffExpiresAt: "2026-01-02T00:00:00.000Z",
      },
    });
    expect(finishSession).toHaveBeenCalledWith(
      expect.not.objectContaining({ concurrencyId: expect.anything() }),
    );
    expect(finishSession).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: null, expectedStatus: "timed_out" }),
    );
    expect(state.sessions.get(session.id)?.terminalHookHandoff).toMatchObject({
      hostId: "host",
      worktreeId: null,
    });
    await expect(
      handleHostMessageDurable(state, deferredStatus(null), undefined, false, false, 7),
    ).resolves.toMatchObject({
      sessionStatusAcknowledged: { terminalHookHandoffId: "detached-timeout" },
    });
    expect(finishSession).toHaveBeenCalledTimes(1);
  });

  it("replays the committed late-terminal handoff after a cleanup write race", async () => {
    const state = createControlPlaneState({ now: () => NOW, idFactory: () => "proposed-handoff" });
    const session = running({ status: "cancelled", completedAt: NOW });
    const winner = {
      handoffId: "committed-handoff",
      attemptId: "attempt",
      hostId: "host",
      repositoryId: "repo",
      worktreeId: "worktree",
      status: "failed" as const,
      errorCode: "checkout_fetch_failed" as const,
      expiresAt: "2026-01-02T00:00:00.000Z",
    };
    let persisted: SessionRecord = session;
    setDurableReadStorage(state, {
      finishSession: async () => {
        persisted = { ...session, worktreeId: null, terminalHookHandoff: winner };
        return true;
      },
      getSession: async () => persisted,
      listLogs: async () => [],
    });
    state.sessions.set(session.id, session);

    await expect(
      handleHostMessageDurable(state, deferredStatus("worktree"), undefined, false, false, 7),
    ).resolves.toMatchObject({
      sessionStatusAcknowledged: {
        terminalHookHandoffId: "committed-handoff",
        terminalHookHandoffExpiresAt: winner.expiresAt,
      },
    });
  });

  it("acknowledges the handoff that a concurrent terminal status committed", async () => {
    const state = createControlPlaneState({ now: () => NOW, idFactory: () => "proposed-handoff" });
    const session = running();
    const committedHandoff = {
      handoffId: "committed-handoff",
      attemptId: "attempt",
      hostId: "host",
      repositoryId: "repo",
      worktreeId: "worktree",
      status: "failed" as const,
      errorCode: "checkout_fetch_failed" as const,
      expiresAt: "2026-01-02T00:00:00.000Z",
    };
    let persisted: SessionRecord = session;
    const finishSession = vi.fn(
      async (input: { terminalHookHandoff?: SessionRecord["terminalHookHandoff"] }) => {
        expect(input.terminalHookHandoff?.handoffId).toBe("proposed-handoff");
        persisted = {
          ...session,
          status: "failed",
          worktreeId: null,
          terminalHookHandoff: committedHandoff,
        };
        return true;
      },
    );
    const putArchive = vi.fn(async () => undefined);
    setDurableReadStorage(state, {
      getSession: async () => persisted,
      finishSession,
      putArchive,
      listLogs: async () => [],
    });
    state.sessions.set(session.id, session);

    await expect(
      handleHostMessageDurable(state, deferredStatus("worktree"), undefined, false, false, 7),
    ).resolves.toMatchObject({
      sessionStatusAcknowledged: {
        retryAccepted: false,
        terminalHookHandoffId: "committed-handoff",
        terminalHookHandoffExpiresAt: "2026-01-02T00:00:00.000Z",
      },
    });
    expect(state.sessions.get(session.id)?.terminalHookHandoff?.handoffId).toBe(
      "committed-handoff",
    );
    expect(putArchive).not.toHaveBeenCalled();
  });
});
