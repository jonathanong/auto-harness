import { describe, expect, it, vi } from "vitest";

import { createControlPlaneState } from "./control-plane-state.ts";
import { offlineHostAndRequeueDurableImpl } from "./control-plane-worktrees-disconnect.ts";
import type { SessionRecord, WorktreeRecord } from "./db/types.ts";

const NOW = "2026-01-01T00:00:00.000Z";

describe("disconnect durable fallback coverage", () => {
  it("uses the listed worktree when the authoritative worktree disappeared during requeue", async () => {
    const state = createControlPlaneState({ now: () => NOW });
    const worktree: WorktreeRecord = {
      id: "w",
      name: "w",
      hostId: "host",
      repositoryId: "repo",
      path: "/repo/w",
      labels: [],
      status: "busy",
      online: true,
      currentSessionId: "s",
      connectionId: "connection",
    };
    const session: SessionRecord = {
      id: "s",
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
      onConflict: "queue",
      status: "running",
      queueShard: 0,
      createdAt: NOW,
      type: "prompt",
      source: "api",
      hostId: "host",
      worktreeId: "w",
      attemptId: "attempt",
      ackReceivedAt: NOW,
      assignmentConnectionId: "connection",
    };
    const releaseLegacyHostAssignment = vi.fn(async () => false);
    state.storage = {
      listWorktreesByHost: async () => [worktree],
      getSession: async () => session,
      markReconnectPending: async () => false,
      getWorktree: async () => null,
      tryRequeueSession: async () => true,
      releaseLegacyHostAssignment,
    } as never;
    await expect(
      offlineHostAndRequeueDurableImpl(state, "host", "connection", "offline", () => []),
    ).resolves.toEqual(["s"]);
    expect(state.worktrees.get("w")).toMatchObject({ status: "idle", online: false });
    expect(releaseLegacyHostAssignment).toHaveBeenCalledWith({
      sessionId: "s",
      attemptId: "attempt",
      hostId: "host",
      connectionId: "connection",
    });
  });

  it("repairs legacy capacity only after cancelled and unacknowledged releases succeed", async () => {
    // eslint-disable-next-line unicorn/consistent-function-scoping -- scoped test fixture.
    const worktree = (id: string): WorktreeRecord => ({
      id,
      name: id,
      hostId: "host",
      repositoryId: "repo",
      path: `/repo/${id}`,
      labels: [],
      status: "busy",
      online: true,
      currentSessionId: id,
      connectionId: "connection",
    });
    const session = (id: string, status: "running" | "cancelled"): SessionRecord => ({
      id,
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
      onConflict: "queue",
      status,
      queueShard: 0,
      createdAt: NOW,
      type: "prompt",
      source: "api",
      hostId: "host",
      worktreeId: id,
      attemptId: "attempt",
      assignmentConnectionId: "connection",
      resolvedRoute: {
        targetIndex: 0,
        providerAccountId: "account",
        commandId: "cmd",
        hostId: "host",
        worktreeId: id,
        attemptId: "attempt",
      },
    });
    const releaseLegacyHostAssignment = vi.fn(async () => false);

    const cancelled = createControlPlaneState({ now: () => NOW });
    const cancelledWorktree = worktree("cancelled");
    const cancelledSession = session("cancelled", "cancelled");
    cancelled.storage = {
      listWorktreesByHost: async () => [cancelledWorktree],
      getSession: async () => cancelledSession,
      releaseCancelledSessionWorktree: async () => true,
      releaseLegacyHostAssignment,
    } as never;
    await offlineHostAndRequeueDurableImpl(cancelled, "host", "connection", "offline", () => []);

    const unacknowledged = createControlPlaneState({ now: () => NOW });
    const unacknowledgedWorktree = worktree("unacknowledged");
    const unacknowledgedSession = session("unacknowledged", "running");
    unacknowledged.storage = {
      listWorktreesByHost: async () => [unacknowledgedWorktree],
      getSession: async () => unacknowledgedSession,
      tryRequeueSession: async () => true,
      releaseLegacyHostAssignment,
    } as never;
    await offlineHostAndRequeueDurableImpl(
      unacknowledged,
      "host",
      "connection",
      "offline",
      () => [],
    );

    expect(releaseLegacyHostAssignment).toHaveBeenCalledTimes(2);
    expect(releaseLegacyHostAssignment).toHaveBeenNthCalledWith(1, {
      sessionId: "cancelled",
      attemptId: "attempt",
      hostId: "host",
      connectionId: "connection",
    });
    expect(releaseLegacyHostAssignment).toHaveBeenNthCalledWith(2, {
      sessionId: "unacknowledged",
      attemptId: "attempt",
      hostId: "host",
      connectionId: "connection",
    });
  });
});
