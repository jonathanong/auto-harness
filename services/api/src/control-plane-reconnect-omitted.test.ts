/* eslint-disable max-lines -- omitted-session reconnect cases share one state builder. */
import { describe, expect, it } from "vitest";

import { createControlPlaneState } from "./control-plane-state.ts";
import { reconcileHostOwnedSessions } from "./control-plane-reconnect-omitted.ts";
import type { SessionRecord, WorktreeRecord } from "./db/types.ts";

describe("reconcileHostOwnedSessions", () => {
  it("requeues omitted in-memory worktree sessions and skips healthy claims", async () => {
    const state = createControlPlaneState();
    const omitted = {
      id: "omitted",
      repositoryId: "repo",
      prompt: "run",
      target: { commandId: "cmd" },
      fallbacks: [],
      targetDisplayNames: ["cmd"],
      queueTtlSeconds: 60,
      queueExpiresAt: "2099-01-01T00:00:00.000Z",
      timeout: 30,
      priority: 0,
      requiredLabels: [],
      status: "running",
      queueShard: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      hostId: "host",
      worktreeId: "wt-1",
      attemptId: "attempt",
      ackReceivedAt: "2026-01-01T00:00:01.000Z",
      primaryCommandStartState: "pending",
    } as SessionRecord;
    const running = { ...omitted, id: "running", worktreeId: "wt-2" };
    state.sessions.set(omitted.id, omitted);
    state.sessions.set(running.id, running);
    state.worktrees.set("wt-1", {
      id: "wt-1",
      name: "wt-1",
      hostId: "host",
      repositoryId: "repo",
      path: "/wt-1",
      labels: [],
      status: "busy",
      currentSessionId: "omitted",
      online: true,
    } as WorktreeRecord);
    state.worktrees.set("wt-2", {
      id: "wt-2",
      name: "wt-2",
      hostId: "host",
      repositoryId: "repo",
      path: "/wt-2",
      labels: [],
      status: "busy",
      currentSessionId: "running",
      online: true,
    } as WorktreeRecord);

    const requeued = await reconcileHostOwnedSessions(
      state,
      "host",
      undefined,
      new Set(["running"]),
      "host-omitted",
    );
    expect(requeued).toEqual(["omitted"]);
    expect(state.sessions.get("omitted")?.status).not.toBe("running");
    expect(state.sessions.get("omitted")).toMatchObject({
      infrastructureRetryCount: 1,
      lastInfrastructureErrorCode: "host_lost",
    });
    expect(state.worktrees.get("wt-1")?.status).toBe("idle");
    expect(state.sessions.get("running")?.status).toBe("running");
  });

  it("does not replay an omitted assignment after command authorization", async () => {
    const state = createControlPlaneState({ now: () => "2026-01-01T00:00:02.000Z" });
    const session = {
      id: "authorized",
      repositoryId: "repo",
      prompt: "run",
      target: { commandId: "cmd" },
      fallbacks: [],
      targetDisplayNames: ["cmd"],
      queueTtlSeconds: 60,
      queueExpiresAt: "2099-01-01T00:00:00.000Z",
      timeout: 30,
      priority: 0,
      requiredLabels: [],
      status: "running",
      queueShard: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      hostId: "host",
      worktreeId: "wt",
      attemptId: "attempt",
      ackReceivedAt: "2026-01-01T00:00:01.000Z",
      primaryCommandStartState: "authorized",
    } as SessionRecord;
    state.sessions.set(session.id, session);
    state.worktrees.set("wt", {
      id: "wt",
      name: "wt",
      hostId: "host",
      repositoryId: "repo",
      path: "/wt",
      labels: [],
      status: "busy",
      currentSessionId: session.id,
      online: true,
    } as WorktreeRecord);

    expect(
      await reconcileHostOwnedSessions(state, "host", undefined, new Set(), "omitted"),
    ).toEqual([]);
    expect(state.sessions.get(session.id)).toMatchObject({
      status: "failed",
      errorCode: "host_lost",
    });
    expect(state.worktrees.get("wt")).toMatchObject({
      status: "busy",
      currentSessionId: "authorized",
    });
  });

  it("covers durable omitted terminal, losing, and missing-worktree outcomes", async () => {
    const base: SessionRecord = {
      id: "terminal",
      repositoryId: "repo",
      prompt: "run",
      target: { commandId: "cmd" },
      fallbacks: [],
      targetDisplayNames: ["cmd"],
      queueTtlSeconds: 60,
      queueExpiresAt: "2099-01-01T00:00:00.000Z",
      timeout: 30,
      priority: 0,
      requiredLabels: [],
      onConflict: "queue",
      status: "running",
      queueShard: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      hostId: "host",
      worktreeId: "wt",
      attemptId: "attempt",
      ackReceivedAt: "2026-01-01T00:00:01.000Z",
      primaryCommandStartState: "authorized",
      assignmentConnectionId: "old",
      concurrencyId: "concurrency",
    };
    const wt: WorktreeRecord = {
      id: "wt",
      name: "wt",
      hostId: "host",
      repositoryId: "repo",
      path: "/wt",
      labels: [],
      status: "busy",
      currentSessionId: base.id,
      online: true,
    } as WorktreeRecord;

    const missingWorktree = createControlPlaneState();
    missingWorktree.storage = {
      listActiveSessionsByHost: async () => [base],
      getWorktree: async () => null,
    } as never;
    expect(
      await reconcileHostOwnedSessions(missingWorktree, "host", "connection", new Set(), "lost"),
    ).toEqual([]);

    const noFinish = createControlPlaneState();
    noFinish.storage = {
      listActiveSessionsByHost: async () => [base],
      getWorktree: async () => wt,
      tryRequeueSession: async () => {
        throw new Error("terminal sessions must not be requeued");
      },
    } as never;
    expect(
      await reconcileHostOwnedSessions(noFinish, "host", "connection", new Set(), "lost"),
    ).toEqual([]);

    const finished = createControlPlaneState();
    let finishOptions: Record<string, unknown> | undefined;
    finished.storage = {
      listActiveSessionsByHost: async () => [base],
      getWorktree: async () => wt,
      finishSession: async (options: Record<string, unknown>) => {
        finishOptions = options;
        return true;
      },
    } as never;
    expect(
      await reconcileHostOwnedSessions(finished, "host", "connection", new Set(), "lost"),
    ).toEqual([]);
    expect(finishOptions).toMatchObject({
      concurrencyId: "concurrency",
      fence: { hostId: "host", connectionId: "connection" },
    });
    expect(finished.sessions.get(base.id)).toMatchObject({ status: "failed" });
    expect(finished.worktrees.get(wt.id)).toMatchObject({
      status: "busy",
      currentSessionId: base.id,
    });

    const finishLosing = createControlPlaneState();
    finishLosing.storage = {
      listActiveSessionsByHost: async () => [{ ...base, concurrencyId: undefined }],
      getWorktree: async () => wt,
      finishSession: async () => false,
    } as never;
    expect(
      await reconcileHostOwnedSessions(finishLosing, "host", "connection", new Set(), "lost"),
    ).toEqual([]);

    const losing = createControlPlaneState();
    const pending = {
      ...base,
      id: "pending",
      primaryCommandStartState: "pending" as const,
      ackReceivedAt: undefined,
      assignmentConnectionId: undefined,
      concurrencyId: undefined,
    };
    losing.storage = {
      listActiveSessionsByHost: async () => [pending],
      getWorktree: async () => ({ ...wt, id: "wt-pending", currentSessionId: pending.id }),
      tryRequeueSession: async () => false,
    } as never;
    expect(
      await reconcileHostOwnedSessions(losing, "host", "connection", new Set(), "lost"),
    ).toEqual([]);

    const requeued = createControlPlaneState();
    requeued.storage = {
      listActiveSessionsByHost: async () => [{ ...pending, assignmentConnectionId: "old" }],
      getWorktree: async () => ({ ...wt, id: "wt-requeued", currentSessionId: pending.id }),
      tryRequeueSession: async () => true,
    } as never;
    expect(
      await reconcileHostOwnedSessions(requeued, "host", "connection", new Set(), "lost"),
    ).toEqual([pending.id]);
  });
});
