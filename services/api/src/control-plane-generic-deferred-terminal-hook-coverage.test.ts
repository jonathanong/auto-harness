import { describe, expect, it, vi } from "vitest";

import { setDurableReadStorage } from "../test-helpers/control-plane-durable-read-test-helpers.ts";
import { handleHostMessageDurable } from "./control-plane-messages.ts";
import { createControlPlaneState } from "./control-plane-state.ts";
import type { SessionRecord } from "./db/types.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const EXPIRES = "2026-01-02T00:00:00.000Z";

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
    activeHostId: "host",
    activeHostOrder: `${NOW}#session`,
    ...overrides,
  };
}

function deferredSetupStatus(worktreeId: string | null) {
  return {
    type: "session:status" as const,
    sessionId: "session",
    worktreeId,
    attemptId: "attempt",
    status: "failed" as const,
    errorCode: "setup_failed" as const,
    deferTerminalHookResult: true as const,
  };
}

function expectReplay(result: unknown, handoffId: string): void {
  expect(result).toMatchObject({
    sessionStatusAcknowledged: {
      sessionId: "session",
      attemptId: "attempt",
      terminalHookHandoffId: handoffId,
      terminalHookHandoffExpiresAt: EXPIRES,
    },
  });
}

describe("generic deferred terminal hook coverage", () => {
  it("stores and replays an ignored setup-failure handoff for a worktree", async () => {
    const state = createControlPlaneState({ now: () => NOW, idFactory: () => "worktree-handoff" });
    const session = running();
    const finishSession = vi.fn(
      async (input: { terminalHookHandoff?: SessionRecord["terminalHookHandoff"] }) => {
        state.sessions.set(session.id, {
          ...session,
          status: "failed",
          worktreeId: null,
          hostId: null,
          terminalHookHandoff: input.terminalHookHandoff,
        });
        return true;
      },
    );
    setDurableReadStorage(state, {
      finishSession,
      getSession: async () => state.sessions.get(session.id) ?? null,
      listLogs: async () => [],
      putArchive: async () => undefined,
    });
    state.sessions.set(session.id, session);

    const report = deferredSetupStatus("worktree");
    expectReplay(
      await handleHostMessageDurable(state, report, undefined, false, false, 7),
      "worktree-handoff",
    );
    expect(finishSession).toHaveBeenCalledWith(
      expect.objectContaining({
        terminalHookHandoff: expect.objectContaining({
          handoffId: "worktree-handoff",
          worktreeId: "worktree",
          errorCode: "setup_failed",
        }),
      }),
    );

    expectReplay(
      await handleHostMessageDurable(state, report, undefined, false, false, 7),
      "worktree-handoff",
    );
    expect(finishSession).toHaveBeenCalledTimes(1);
  });

  it("stores and replays an ignored setup-failure handoff for a main checkout", async () => {
    const state = createControlPlaneState({ now: () => NOW, idFactory: () => "main-handoff" });
    const session = running({
      worktreeId: null,
      mainCheckoutLease: true,
      assignmentConnectionId: "connection",
    });
    const releaseMainCheckoutSession = vi.fn(
      async (input: { terminalHookHandoff?: SessionRecord["terminalHookHandoff"] }) => {
        state.sessions.set(session.id, {
          ...session,
          status: "failed",
          worktreeId: null,
          hostId: null,
          terminalHookHandoff: input.terminalHookHandoff,
        });
        return true;
      },
    );
    setDurableReadStorage(state, {
      releaseMainCheckoutSession,
      getSession: async () => state.sessions.get(session.id) ?? null,
      listLogs: async () => [],
      putArchive: async () => undefined,
    });
    state.sessions.set(session.id, session);
    state.mainCheckoutLeases.set("host\0repo", {
      sessionId: session.id,
      connectionId: "connection",
    });

    const report = deferredSetupStatus(null);
    expectReplay(
      await handleHostMessageDurable(state, report, undefined, false, false, 7),
      "main-handoff",
    );
    expect(releaseMainCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({
        terminalHookHandoff: expect.objectContaining({
          handoffId: "main-handoff",
          worktreeId: null,
          mainCheckoutLease: true,
          errorCode: "setup_failed",
        }),
      }),
    );

    expectReplay(
      await handleHostMessageDurable(state, report, undefined, false, false, 7),
      "main-handoff",
    );
    expect(releaseMainCheckoutSession).toHaveBeenCalledTimes(1);
  });
});
