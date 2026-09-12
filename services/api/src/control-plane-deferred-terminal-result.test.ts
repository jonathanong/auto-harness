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
  it("retains a worktree hook handoff and withholds archival", async () => {
    const state = createControlPlaneState({ now: () => NOW, idFactory: () => "handoff" });
    const session = running();
    const finishSession = vi.fn(
      async (input: { terminalHookHandoff?: SessionRecord["terminalHookHandoff"] }) => {
        if (!input.terminalHookHandoff) return false;
        state.sessions.set(session.id, {
          ...session,
          status: "failed",
          worktreeId: null,
          terminalHookHandoff: input.terminalHookHandoff,
        });
        return true;
      },
    );
    const putArchive = vi.fn(async () => undefined);
    setDurableReadStorage(state, {
      finishSession,
      putArchive,
      listLogs: async () => [],
    });
    state.sessions.set(session.id, session);

    await expect(
      handleHostMessageDurable(state, deferredStatus("worktree"), undefined, false, false, 7),
    ).resolves.toMatchObject({
      sessionStatusAcknowledged: {
        sessionId: "session",
        attemptId: "attempt",
        retryAccepted: false,
        terminalHookHandoffId: "handoff",
        terminalHookHandoffExpiresAt: "2026-01-02T00:00:00.000Z",
      },
    });
    expect(finishSession).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        terminalHookHandoff: expect.objectContaining({
          handoffId: "handoff",
          worktreeId: "worktree",
          errorCode: "checkout_fetch_failed",
        }),
      }),
    );
    expect(state.sessions.get("session")).toMatchObject({
      status: "failed",
      terminalHookHandoff: { handoffId: "handoff" },
    });
    expect(putArchive).not.toHaveBeenCalled();
  });

  it("retains a main-checkout hook handoff and withholds archival", async () => {
    const state = createControlPlaneState({ now: () => NOW, idFactory: () => "main-handoff" });
    const session = running({
      worktreeId: null,
      mainCheckoutLease: true,
      assignmentConnectionId: "connection",
    });
    const releaseMainCheckoutSession = vi.fn(
      async (input: { terminalHookHandoff?: SessionRecord["terminalHookHandoff"] }) => {
        if (!input.terminalHookHandoff) return false;
        state.sessions.set(session.id, {
          ...session,
          status: "failed",
          worktreeId: null,
          terminalHookHandoff: input.terminalHookHandoff,
        });
        return true;
      },
    );
    const putArchive = vi.fn(async () => undefined);
    setDurableReadStorage(state, {
      releaseMainCheckoutSession,
      putArchive,
      listLogs: async () => [],
    });
    state.sessions.set(session.id, session);
    state.mainCheckoutLeases.set("host\0repo", {
      sessionId: "session",
      connectionId: "connection",
    });

    await expect(
      handleHostMessageDurable(state, deferredStatus(null), undefined, false, false, 7),
    ).resolves.toMatchObject({
      sessionStatusAcknowledged: {
        retryAccepted: false,
        terminalHookHandoffId: "main-handoff",
        terminalHookHandoffExpiresAt: "2026-01-02T00:00:00.000Z",
      },
    });
    expect(releaseMainCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        terminalHookHandoff: expect.objectContaining({
          handoffId: "main-handoff",
          worktreeId: null,
        }),
      }),
    );
    expect(putArchive).not.toHaveBeenCalled();
  });

  it("acknowledges the handoff that a concurrent terminal status committed", async () => {
    const state = createControlPlaneState({ now: () => NOW, idFactory: () => "proposed-handoff" });
    const session = running();
    const committedHandoff = {
      handoffId: "committed-handoff",
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
