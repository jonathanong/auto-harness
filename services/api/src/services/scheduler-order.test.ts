import { describe, expect, it } from "vitest";

import { MemorySessionRepository, MemoryWorktreeRepository } from "../db/memory-repos.ts";
import { Scheduler } from "./scheduler.ts";

describe("Scheduler ordering", () => {
  it("breaks priority ties by createdAt and worktree ties by id", async () => {
    const sessions = new MemorySessionRepository();
    const worktrees = new MemoryWorktreeRepository();
    worktrees.seed({
      id: "wt-b",
      name: "wt-b",
      agentId: "a1",
      repositoryId: "r1",
      path: "/b",
      labels: [],
      status: "idle",
      online: true,
      lastAssignedAt: "same",
    });
    worktrees.seed({
      id: "wt-a",
      name: "wt-a",
      agentId: "a1",
      repositoryId: "r1",
      path: "/a",
      labels: [],
      status: "idle",
      online: true,
      lastAssignedAt: "same",
    });
    await sessions.putNew({
      id: "later",
      repositoryId: "r1",
      prompt: "p",
      commandProfile: "c",
      timeout: 1,
      priority: 5,
      requiredLabels: [],
      onConflict: "queue",
      status: "queued",
      queueShard: 0,
      createdAt: "t2",
    });
    await sessions.putNew({
      id: "earlier",
      repositoryId: "r1",
      prompt: "p",
      commandProfile: "c",
      timeout: 1,
      priority: 5,
      requiredLabels: [],
      onConflict: "queue",
      status: "queued",
      queueShard: 0,
      createdAt: "t1",
    });
    await sessions.putNew({
      id: "same-time-a",
      repositoryId: "r1",
      prompt: "p",
      commandProfile: "c",
      timeout: 1,
      priority: 5,
      requiredLabels: [],
      onConflict: "queue",
      status: "queued",
      queueShard: 0,
      createdAt: "t1",
    });
    const scheduler = new Scheduler({
      sessions,
      worktrees,
      shardCount: 1,
      now: () => "now",
    });
    const assigned = await scheduler.assignQueued();
    expect(assigned[0]?.session.id).toBe("earlier");
    expect(assigned[0]?.worktree.id).toBe("wt-a");
  });

  it("orders worktrees by lastAssignedAt when timestamps differ", async () => {
    const sessions = new MemorySessionRepository();
    const worktrees = new MemoryWorktreeRepository();
    worktrees.seed({
      id: "wt-old",
      name: "wt-old",
      agentId: "a1",
      repositoryId: "r1",
      path: "/o",
      labels: [],
      status: "idle",
      online: true,
      lastAssignedAt: "2020-01-01T00:00:00.000Z",
    });
    worktrees.seed({
      id: "wt-unset",
      name: "wt-unset",
      agentId: "a1",
      repositoryId: "r1",
      path: "/u",
      labels: [],
      status: "idle",
      online: true,
      lastAssignedAt: null,
    });
    worktrees.seed({
      id: "wt-new",
      name: "wt-new",
      agentId: "a1",
      repositoryId: "r1",
      path: "/n",
      labels: [],
      status: "idle",
      online: true,
      lastAssignedAt: "2025-01-01T00:00:00.000Z",
    });
    await sessions.putNew({
      id: "s1",
      repositoryId: "r1",
      prompt: "p",
      commandProfile: "c",
      timeout: 1,
      priority: 0,
      requiredLabels: [],
      onConflict: "queue",
      status: "queued",
      queueShard: 0,
      createdAt: "t",
    });
    const scheduler = new Scheduler({
      sessions,
      worktrees,
      shardCount: 1,
      now: () => "now",
    });
    const assigned = await scheduler.assignQueued();
    // empty lastAssignedAt sorts first
    expect(assigned[0]?.worktree.id).toBe("wt-unset");
  });
});
