import { describe, expect, it } from "vitest";

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
      targetLabels: ["cmd"],
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
    state.storage = {
      listWorktreesByHost: async () => [worktree],
      getSession: async () => session,
      markReconnectPending: async () => false,
      getWorktree: async () => null,
      tryRequeueSession: async () => true,
    } as never;
    await expect(
      offlineHostAndRequeueDurableImpl(state, "host", "connection", "offline", () => []),
    ).resolves.toEqual(["s"]);
    expect(state.worktrees.get("w")).toMatchObject({ status: "idle", online: false });
  });
});
