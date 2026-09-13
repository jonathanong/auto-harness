/* eslint-disable max-lines -- omitted-session reconnect cases share one state builder. */
import { describe, expect, it, vi } from "vitest";

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

  it("requeues local workspace ownership and ignores foreign or reported slots", async () => {
    const state = createControlPlaneState();
    const workspace = {
      id: "workspace",
      repositoryId: "",
      workspacePoolId: "pool",
      workspaceSlotId: "slot",
      workspaceSlotLease: true,
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
      worktreeId: null,
      attemptId: "attempt",
    } as SessionRecord;
    const foreign = { ...workspace, id: "foreign", workspaceSlotId: "foreign-slot" };
    const reported = { ...workspace, id: "reported", workspaceSlotId: "reported-slot" };
    state.sessions.set(workspace.id, workspace);
    state.sessions.set(foreign.id, foreign);
    state.sessions.set(reported.id, reported);
    state.workspaceSlots.set("slot", {
      id: "slot",
      name: "slot",
      path: "/workspace/slot",
      hostId: "host",
      workspacePoolId: "pool",
      status: "busy",
      online: true,
      currentSessionId: workspace.id,
      errorMessage: "stale error",
    });
    state.workspaceSlots.set("foreign-slot", {
      id: "foreign-slot",
      name: "foreign",
      path: "/workspace/foreign",
      hostId: "other-host",
      workspacePoolId: "pool",
      status: "busy",
      online: true,
      currentSessionId: foreign.id,
    });
    state.workspaceSlots.set("reported-slot", {
      id: "reported-slot",
      name: "reported",
      path: "/workspace/reported",
      hostId: "host",
      workspacePoolId: "pool",
      status: "busy",
      online: true,
      currentSessionId: reported.id,
    });

    await expect(
      reconcileHostOwnedSessions(state, "host", undefined, new Set([reported.id]), "omitted"),
    ).resolves.toEqual([workspace.id]);
    expect(state.sessions.get(workspace.id)).toMatchObject({
      status: "queued",
      workspaceSlotId: null,
    });
    expect(state.workspaceSlots.get("slot")).toMatchObject({
      status: "idle",
      currentSessionId: null,
    });
    expect(state.workspaceSlots.get("slot")).not.toHaveProperty("errorMessage");
    expect(state.sessions.get(foreign.id)?.status).toBe("running");
    expect(state.sessions.get(reported.id)?.status).toBe("running");
  });

  it("does not release a durable workspace row without the current connection", async () => {
    const state = createControlPlaneState();
    const workspace = {
      id: "workspace",
      repositoryId: "",
      workspacePoolId: "pool",
      workspaceSlotId: "slot",
      workspaceSlotLease: true,
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
      worktreeId: null,
      attemptId: "attempt",
    } as SessionRecord;
    const slot = {
      id: "slot",
      name: "slot",
      path: "/workspace/slot",
      hostId: "host",
      workspacePoolId: "pool",
      status: "busy" as const,
      online: true,
      currentSessionId: workspace.id,
    };
    state.sessions.set(workspace.id, workspace);
    const finishSession = vi.fn(async () => true);
    state.storage = { getWorkspaceSlot: async () => slot, finishSession } as never;

    await expect(
      reconcileHostOwnedSessions(state, "host", undefined, new Set(), "omitted"),
    ).resolves.toEqual([]);
    expect(finishSession).not.toHaveBeenCalled();
    expect(state.sessions.get(workspace.id)?.status).toBe("running");
  });

  it("bounds omitted workspace host loss to one pre-launch retry and terminalizes post-launch loss", async () => {
    const state = createControlPlaneState();
    const retry = {
      id: "retry",
      repositoryId: "",
      workspacePoolId: "pool",
      workspaceSlotId: "retry-slot",
      workspaceSlotLease: true,
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
      worktreeId: null,
      attemptId: "retry-attempt",
      ackReceivedAt: "2026-01-01T00:00:01.000Z",
      primaryCommandStartState: "pending",
    } as SessionRecord;
    const terminal = {
      ...retry,
      id: "terminal",
      workspaceSlotId: "terminal-slot",
      attemptId: "terminal-attempt",
      primaryCommandStartState: "authorized" as const,
    };
    state.sessions.set(retry.id, retry);
    state.sessions.set(terminal.id, terminal);
    for (const session of [retry, terminal]) {
      state.workspaceSlots.set(session.workspaceSlotId!, {
        id: session.workspaceSlotId!,
        name: session.workspaceSlotId!,
        path: `/workspace/${session.id}`,
        hostId: "host",
        workspacePoolId: "pool",
        status: "busy",
        online: true,
        currentSessionId: session.id,
      });
    }

    await expect(
      reconcileHostOwnedSessions(state, "host", undefined, new Set(), "host omitted"),
    ).resolves.toEqual([retry.id]);
    expect(state.sessions.get(retry.id)).toMatchObject({
      status: "queued",
      infrastructureRetryCount: 1,
      lastInfrastructureErrorCode: "host_lost",
      workspaceSlotId: null,
    });
    expect(state.sessions.get(terminal.id)).toMatchObject({
      status: "failed",
      errorCode: "host_lost",
    });
    expect(state.sessions.get(terminal.id)).not.toHaveProperty("workspaceSlotId");
    expect(state.workspaceSlots.get("retry-slot")).toMatchObject({
      status: "idle",
      currentSessionId: null,
    });
    expect(state.workspaceSlots.get("terminal-slot")).toMatchObject({
      status: "idle",
      currentSessionId: null,
    });
  });
});
