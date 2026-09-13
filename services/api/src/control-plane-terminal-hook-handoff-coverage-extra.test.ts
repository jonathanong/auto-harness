/* eslint-disable max-lines -- terminal handoff lifecycle branches share state fixtures. */
import { describe, expect, it, vi } from "vitest";

import {
  canRetryHostLoss,
  finishHostLostSession,
  queueHostLossRetry,
} from "./control-plane-infrastructure-retry.ts";
import { createControlPlaneState } from "./control-plane-state.ts";
import {
  expireTerminalHookHandoffIfNeeded,
  pendingTerminalHookHandoffs,
  settleTerminalHookHandoff,
} from "./control-plane-terminal-hook-handoff.ts";
import type { SessionRecord } from "./db/types.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function running(overrides: Partial<SessionRecord> = {}): SessionRecord {
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
    ...overrides,
  };
}

function finished(overrides: Partial<SessionRecord> = {}): SessionRecord {
  const owner = createControlPlaneState({ now: () => NOW, idFactory: () => "handoff" });
  return finishHostLostSession(owner, running(overrides));
}

describe("terminal hook handoff coverage", () => {
  it("uses explicit protocol negotiation and filters targeted in-memory delivery", async () => {
    const state = createControlPlaneState({ now: () => NOW });
    const deliverable = finished({ ref: "refs/heads/main", metadata: { source: "test" } });
    state.sessions.set(deliverable.id, deliverable);
    state.sessions.set("ordinary", running({ id: "ordinary", activeHostId: "host" }));
    state.sessions.set("other-host", {
      ...finished(),
      id: "other-host",
      terminalHookHandoff: {
        ...finished().terminalHookHandoff!,
        hostId: "other",
      },
    });

    await expect(pendingTerminalHookHandoffs(state, "host")).resolves.toEqual([]);
    await expect(
      pendingTerminalHookHandoffs(state, "host", {
        protocolVersion: 7,
        sessionIds: ["missing", "session"],
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        handoffId: "handoff",
        expiresAt: "2026-01-02T00:00:00.000Z",
        ref: "refs/heads/main",
        metadata: { source: "test" },
      }),
    ]);
  });

  it("supports both bounded durable lookup paths", async () => {
    const state = createControlPlaneState({ now: () => NOW });
    const session = finished();
    const getSession = vi.fn(async (id: string) => (id === session.id ? session : null));
    const listActiveSessionsByHost = vi.fn(async () => [session]);
    state.storage = { getSession, listActiveSessionsByHost } as never;

    await expect(
      pendingTerminalHookHandoffs(state, "host", {
        protocolVersion: 7,
        sessionIds: ["missing", session.id],
      }),
    ).resolves.toHaveLength(1);
    expect(getSession).toHaveBeenCalledTimes(2);
    await expect(
      pendingTerminalHookHandoffs(state, "host", { protocolVersion: 7 }),
    ).resolves.toHaveLength(1);
    expect(listActiveSessionsByHost).toHaveBeenCalledWith("host");
  });

  it("expires without a cached connection and omits absent optional payload fields", async () => {
    const state = createControlPlaneState({ now: () => "2026-01-02T00:00:00.001Z" });
    const session = finished();
    delete session.terminalHookHandoff!.errorCode;
    state.sessions.set(session.id, session);
    await expect(
      pendingTerminalHookHandoffs(state, "host", { protocolVersion: 7 }),
    ).resolves.toEqual([]);
    expect(state.sessions.get(session.id)?.terminalHookHandoffExpiredAt).toBe(
      "2026-01-02T00:00:00.000Z",
    );

    const current = createControlPlaneState({ now: () => NOW });
    const noHandoff = { ...session, id: "ordinary" };
    delete noHandoff.terminalHookHandoff;
    current.sessions.set(noHandoff.id, noHandoff);
    const deliverable = finished();
    delete deliverable.terminalHookHandoff!.errorCode;
    current.sessions.set(deliverable.id, deliverable);
    await expect(
      pendingTerminalHookHandoffs(current, "host", { protocolVersion: 7 }),
    ).resolves.toEqual([expect.not.objectContaining({ errorCode: expect.anything() })]);
  });

  it("expires a reserved main checkout and a durable cached worktree", async () => {
    const state = createControlPlaneState({ now: () => "2026-01-02T00:00:00.001Z" });
    const main = finished({
      worktreeId: null,
      mainCheckoutLease: true,
      assignmentConnectionId: "connection",
      assignmentSentAt: NOW,
      ackReceivedAt: NOW,
      reconnectDeadlineAt: NOW,
    });
    state.sessions.set(main.id, main);
    state.mainCheckoutLeases.set("host\0repo", {
      sessionId: main.id,
      connectionId: "connection",
    });
    await expect(expireTerminalHookHandoffIfNeeded(state, main, Date.now())).resolves.toBe(true);
    expect(state.mainCheckoutLeases.has("host\0repo")).toBe(false);
    expect(state.sessions.get(main.id)).not.toHaveProperty("mainCheckoutLease");
    expect(state.sessions.get(main.id)).not.toHaveProperty("assignmentConnectionId");
    expect(state.sessions.get(main.id)).not.toHaveProperty("assignmentSentAt");
    expect(state.sessions.get(main.id)).not.toHaveProperty("ackReceivedAt");
    expect(state.sessions.get(main.id)).not.toHaveProperty("reconnectDeadlineAt");

    const settledMain = finished({
      id: "settled-main",
      worktreeId: null,
      mainCheckoutLease: true,
    });
    state.sessions.set(settledMain.id, settledMain);
    state.mainCheckoutLeases.set("host\0repo", {
      sessionId: settledMain.id,
      connectionId: "connection",
    });
    state.storage = {
      getSession: async () => settledMain,
      settleTerminalHookHandoff: async () => true,
    } as never;
    await expect(
      settleTerminalHookHandoff(state, {
        sessionId: settledMain.id,
        handoffId: "handoff",
        hostId: "host",
        connectionId: "connection",
      }),
    ).resolves.toBe(true);
    expect(state.mainCheckoutLeases.has("host\0repo")).toBe(false);

    const worktree = finished({ id: "durable", attemptId: "durable-attempt" });
    state.sessions.set(worktree.id, worktree);
    state.worktrees.set("worktree", {
      id: "worktree",
      hostId: "host",
      repositoryId: "repo",
      status: "busy",
      currentSessionId: worktree.id,
    } as never);
    state.storage = {
      getSession: async () => worktree,
      settleTerminalHookHandoff: async () => true,
    } as never;
    await expect(
      settleTerminalHookHandoff(state, {
        sessionId: worktree.id,
        handoffId: "handoff",
        hostId: "host",
        connectionId: "connection",
        result: { summary: "done", summarySource: "harness" },
      }),
    ).resolves.toBe(true);
    expect(state.worktrees.get("worktree")).toMatchObject({
      status: "idle",
      currentSessionId: null,
    });
    expect(state.sessions.get(worktree.id)?.result).toEqual({
      summary: "done",
      summarySource: "harness",
    });
  });

  it("clears the active host index when no replacement can own the hook", () => {
    const state = createControlPlaneState({ now: () => NOW });
    const result = finishHostLostSession(
      state,
      running({ hostId: null, activeHostId: "lost", activeHostOrder: `${NOW}#session` }),
    );
    expect(result).not.toHaveProperty("terminalHookHandoff");
    expect(result).not.toHaveProperty("activeHostId");
    expect(result).not.toHaveProperty("activeHostOrder");

    const explicitMainHandoff = finishHostLostSession(state, running({ hostId: null }), {
      handoffId: "explicit",
      hostId: "replacement",
      repositoryId: "repo",
      worktreeId: null,
      mainCheckoutLease: true,
      status: "failed",
      errorCode: "host_lost",
      expiresAt: "2026-01-02T00:00:00.000Z",
    });
    expect(explicitMainHandoff.hostId).toBeNull();
  });

  it("preserves a durable handoff when expiry loses and clears a mismatched cached lease", async () => {
    const state = createControlPlaneState({ now: () => NOW });
    const session = finished({
      worktreeId: null,
      mainCheckoutLease: true,
      assignmentConnectionId: "connection",
    });
    state.sessions.set(session.id, session);
    state.mainCheckoutLeases.set("host\0repo", {
      sessionId: "replacement",
      connectionId: "connection",
    });
    const expireTerminalHookHandoff = vi.fn(async () => false);
    state.storage = { expireTerminalHookHandoff } as never;
    await expect(
      expireTerminalHookHandoffIfNeeded(state, session, Date.parse("2026-01-03T00:00:00.000Z")),
    ).resolves.toBe(false);
    expect(state.sessions.get(session.id)?.terminalHookHandoff).toBeDefined();

    expireTerminalHookHandoff.mockResolvedValue(true);
    await expect(
      expireTerminalHookHandoffIfNeeded(state, session, Date.parse("2026-01-03T00:00:00.000Z"), {
        connectionId: "connection",
      }),
    ).resolves.toBe(true);
    expect(expireTerminalHookHandoff).toHaveBeenLastCalledWith(
      expect.objectContaining({
        mainCheckoutRepositoryId: "repo",
        connectionId: "connection",
      }),
    );
    expect(state.mainCheckoutLeases.get("host\0repo")?.sessionId).toBe("replacement");
  });

  it("classifies and records both host-loss retry bounds", () => {
    const pending = running({ primaryCommandStartState: "pending" });
    expect(canRetryHostLoss(pending)).toBe(true);
    expect(canRetryHostLoss({ ...pending, infrastructureRetryCount: 1 })).toBe(false);
    expect(canRetryHostLoss({ ...pending, primaryCommandStartState: "authorized" })).toBe(false);

    expect(queueHostLossRetry(pending)).toMatchObject({
      status: "queued",
      infrastructureRetryCount: 1,
      infrastructureRetryAttemptId: "attempt",
    });
    const withoutAttempt = { ...pending };
    delete withoutAttempt.attemptId;
    expect(queueHostLossRetry(withoutAttempt)).not.toHaveProperty("infrastructureRetryAttemptId");
    expect(
      finishHostLostSession(createControlPlaneState({ now: () => NOW }), {
        ...pending,
        infrastructureRetryCount: 1,
      }),
    ).toMatchObject({ status: "failed", errorCode: "host_lost" });
  });
});
