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
  it("retains a cancelled worktree's deferred setup hook before releasing its cleanup", async () => {
    const state = createControlPlaneState({ now: () => NOW, idFactory: () => "cancelled-handoff" });
    const session = running({ status: "cancelled", completedAt: NOW });
    const finishSession = vi.fn(
      async (input: { terminalHookHandoff?: SessionRecord["terminalHookHandoff"] }) => {
        state.sessions.set(session.id, {
          ...session,
          worktreeId: null,
          terminalHookHandoff: input.terminalHookHandoff,
        });
        return true;
      },
    );
    setDurableReadStorage(state, { finishSession, listLogs: async () => [] });
    state.sessions.set(session.id, session);

    await expect(
      handleHostMessageDurable(state, deferredStatus("worktree"), undefined, false, false, 7),
    ).resolves.toMatchObject({
      sessionStatusAcknowledged: {
        terminalHookHandoffId: "cancelled-handoff",
        terminalHookHandoffExpiresAt: "2026-01-02T00:00:00.000Z",
      },
    });
    expect(finishSession).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "cancelled",
        expectedStatus: "cancelled",
        terminalHookHandoff: expect.objectContaining({ attemptId: "attempt" }),
      }),
    );
    expect(state.sessions.get(session.id)).toMatchObject({
      terminalHookHandoff: { handoffId: "cancelled-handoff" },
    });
  });

  it("retains a timed-out worktree's deferred setup hook before releasing its cleanup", async () => {
    const state = createControlPlaneState({ now: () => NOW, idFactory: () => "timeout-handoff" });
    const session = running({ status: "timed_out", completedAt: NOW });
    const finishSession = vi.fn(
      async (input: { terminalHookHandoff?: SessionRecord["terminalHookHandoff"] }) => {
        state.sessions.set(session.id, {
          ...session,
          worktreeId: null,
          terminalHookHandoff: input.terminalHookHandoff,
        });
        return true;
      },
    );
    setDurableReadStorage(state, { finishSession, listLogs: async () => [] });
    state.sessions.set(session.id, session);

    await expect(
      handleHostMessageDurable(state, deferredStatus("worktree"), undefined, false, false, 7),
    ).resolves.toMatchObject({
      sessionStatusAcknowledged: {
        terminalHookHandoffId: "timeout-handoff",
        terminalHookHandoffExpiresAt: "2026-01-02T00:00:00.000Z",
      },
    });
    expect(finishSession).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "timed_out",
        expectedStatus: "timed_out",
        terminalHookHandoff: expect.objectContaining({ attemptId: "attempt" }),
      }),
    );
  });

  it("retains a cancelled main-checkout hook through its main-lease cleanup", async () => {
    const state = createControlPlaneState({
      now: () => NOW,
      idFactory: () => "main-cancel-handoff",
    });
    const session = running({
      status: "cancelled",
      completedAt: NOW,
      worktreeId: null,
      mainCheckoutLease: true,
      assignmentConnectionId: "connection",
    });
    const releaseMainCheckoutSession = vi.fn(
      async (input: { terminalHookHandoff?: SessionRecord["terminalHookHandoff"] }) => {
        state.sessions.set(session.id, {
          ...session,
          terminalHookHandoff: input.terminalHookHandoff,
        });
        return true;
      },
    );
    setDurableReadStorage(state, { releaseMainCheckoutSession, listLogs: async () => [] });
    state.sessions.set(session.id, session);

    await expect(
      handleHostMessageDurable(state, deferredStatus(null), undefined, false, false, 7),
    ).resolves.toMatchObject({
      sessionStatusAcknowledged: {
        terminalHookHandoffId: "main-cancel-handoff",
        terminalHookHandoffExpiresAt: "2026-01-02T00:00:00.000Z",
      },
    });
    expect(releaseMainCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "cancelled",
        expectedStatus: "cancelled",
        terminalHookHandoff: expect.objectContaining({ mainCheckoutLease: true }),
      }),
    );
  });

  it("retains a timed-out workspace-slot hook through its slot cleanup", async () => {
    const state = createControlPlaneState({
      now: () => NOW,
      idFactory: () => "slot-timeout-handoff",
    });
    const session = running({
      status: "timed_out",
      completedAt: NOW,
      worktreeId: null,
      workspaceSlotId: "slot",
    });
    const finishSession = vi.fn(
      async (input: { terminalHookHandoff?: SessionRecord["terminalHookHandoff"] }) => {
        state.sessions.set(session.id, {
          ...session,
          workspaceSlotId: null,
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
        terminalHookHandoffId: "slot-timeout-handoff",
        terminalHookHandoffExpiresAt: "2026-01-02T00:00:00.000Z",
      },
    });
    expect(finishSession).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "timed_out",
        expectedStatus: "timed_out",
        workspaceSlotId: "slot",
      }),
    );
  });
});
