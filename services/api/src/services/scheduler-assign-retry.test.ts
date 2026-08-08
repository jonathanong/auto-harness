import { describe, expect, it } from "vitest";

import { MemorySessionRepository, MemoryWorktreeRepository } from "../db/memory-repos.ts";
import { Scheduler } from "./scheduler.ts";

describe("Scheduler assign retry and defaults", () => {
  it("skips sessions already bound and retries after lost claim", async () => {
    const sessions = new MemorySessionRepository();
    const worktrees = new MemoryWorktreeRepository();
    worktrees.seed({
      id: "wt-1",
      name: "wt-1",
      hostId: "a1",
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
      hostId: "a1",
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
      commandId: "c",
      targetLabel: "c",
      timeout: 1,
      priority: 0,
      requiredLabels: [],
      onConflict: "queue",
      status: "queued",
      queueShard: 0,
      createdAt: "t0",
      hostId: "a1",
      worktreeId: "wt-x",
    });
    await sessions.putNew({
      id: "open",
      repositoryId: "r1",
      prompt: "p",
      commandId: "c",
      targetLabel: "c",
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
      hostId: "a1",
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
      commandId: "c",
      targetLabel: "c",
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
