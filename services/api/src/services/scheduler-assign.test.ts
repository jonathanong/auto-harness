import { describe, expect, it } from "vitest";

import { MemorySessionRepository, MemoryWorktreeRepository } from "../db/memory-repos.ts";
import { Scheduler } from "./scheduler.ts";

describe("Scheduler assign", () => {
  it("assigns highest priority queued session with exclusive claim", async () => {
    const sessions = new MemorySessionRepository();
    const worktrees = new MemoryWorktreeRepository();
    worktrees.seed({
      id: "wt-1",
      name: "wt-1",
      agentId: "a1",
      repositoryId: "r1",
      path: "/w1",
      labels: ["codex"],
      status: "idle",
      online: true,
      lastAssignedAt: "2026-01-01T00:00:00.000Z",
    });
    worktrees.seed({
      id: "wt-2",
      name: "wt-2",
      agentId: "a1",
      repositoryId: "r1",
      path: "/w2",
      labels: ["codex"],
      status: "idle",
      online: true,
      lastAssignedAt: null,
    });

    await sessions.putNew({
      id: "low",
      repositoryId: "r1",
      prompt: "p",
      commandProfile: "c",
      timeout: 1,
      priority: 1,
      requiredLabels: ["codex"],
      onConflict: "queue",
      status: "queued",
      queueShard: 0,
      createdAt: "t1",
    });
    await sessions.putNew({
      id: "high",
      repositoryId: "r1",
      prompt: "p",
      commandProfile: "c",
      timeout: 1,
      priority: 10,
      requiredLabels: ["codex"],
      onConflict: "queue",
      status: "queued",
      queueShard: 0,
      createdAt: "t2",
    });

    const scheduler = new Scheduler({
      sessions,
      worktrees,
      shardCount: 1,
      now: () => "now",
    });
    const assigned = await scheduler.assignQueued();
    expect(assigned).toHaveLength(2);
    expect(assigned[0]?.session.id).toBe("high");
    // round-robin: null lastAssigned first → wt-2
    expect(assigned[0]?.worktree.id).toBe("wt-2");
    expect(assigned[1]?.worktree.id).toBe("wt-1");
  });

  it("skips when no label match", async () => {
    const sessions = new MemorySessionRepository();
    const worktrees = new MemoryWorktreeRepository();
    worktrees.seed({
      id: "wt-1",
      name: "wt-1",
      agentId: "a1",
      repositoryId: "r1",
      path: "/w",
      labels: ["claude"],
      status: "idle",
      online: true,
    });
    await sessions.putNew({
      id: "s1",
      repositoryId: "r1",
      prompt: "p",
      commandProfile: "c",
      timeout: 1,
      priority: 0,
      requiredLabels: ["codex"],
      onConflict: "queue",
      status: "queued",
      queueShard: 0,
      createdAt: "t",
    });
    const scheduler = new Scheduler({ sessions, worktrees, shardCount: 1 });
    expect(await scheduler.assignQueued()).toHaveLength(0);
  });

  it("skips sessions already bound and retries after lost claim", async () => {
    const sessions = new MemorySessionRepository();
    const worktrees = new MemoryWorktreeRepository();
    worktrees.seed({
      id: "wt-1",
      name: "wt-1",
      agentId: "a1",
      repositoryId: "r1",
      path: "/w1",
      labels: [],
      status: "idle",
      online: true,
      lastAssignedAt: "z",
    });
    worktrees.seed({
      id: "wt-2",
      name: "wt-2",
      agentId: "a1",
      repositoryId: "r1",
      path: "/w2",
      labels: [],
      status: "idle",
      online: true,
      lastAssignedAt: "a",
    });
    await sessions.putNew({
      id: "bound",
      repositoryId: "r1",
      prompt: "p",
      commandProfile: "c",
      timeout: 1,
      priority: 0,
      requiredLabels: [],
      onConflict: "queue",
      status: "queued",
      queueShard: 0,
      createdAt: "t0",
      agentId: "a1",
      worktreeId: "wt-x",
    });
    await sessions.putNew({
      id: "open",
      repositoryId: "r1",
      prompt: "p",
      commandProfile: "c",
      timeout: 1,
      priority: 0,
      requiredLabels: [],
      onConflict: "queue",
      status: "queued",
      queueShard: 0,
      createdAt: "t1",
    });
    const orig = worktrees.tryClaim.bind(worktrees);
    let calls = 0;
    worktrees.tryClaim = async (opts) => {
      calls += 1;
      if (calls === 1) {
        return false;
      }
      return orig(opts);
    };
    const scheduler = new Scheduler({
      sessions,
      worktrees,
      shardCount: 1,
      now: () => "now",
    });
    const assigned = await scheduler.assignQueued();
    expect(assigned.map((a) => a.session.id)).toEqual(["open"]);
    expect(calls).toBeGreaterThan(1);
  });

  it("uses default shard count and now", async () => {
    const sessions = new MemorySessionRepository();
    const worktrees = new MemoryWorktreeRepository();
    worktrees.seed({
      id: "wt-1",
      name: "wt-1",
      agentId: "a1",
      repositoryId: "r1",
      path: "/w",
      labels: [],
      status: "idle",
      online: true,
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
    // remaining shards 1..DEFAULT empty; default now() used on claim
    const scheduler = new Scheduler({ sessions, worktrees });
    const assigned = await scheduler.assignQueued();
    expect(assigned).toHaveLength(1);
  });
});
