import { describe, expect, it } from "vitest";

import { MemorySessionRepository, MemoryWorktreeRepository } from "./memory-repos.ts";

describe("MemorySessionRepository", () => {
  it("stores and lists by status/shard", async () => {
    const repo = new MemorySessionRepository();
    await repo.putNew({
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
      createdAt: "t1",
    });
    await expect(
      repo.putNew({
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
        createdAt: "t1",
      }),
    ).rejects.toThrow(/exists/);
    expect(await repo.get("s1")).toMatchObject({ id: "s1" });
    expect(await repo.get("nope")).toBeNull();
    expect(await repo.listByStatus("queued", 0)).toHaveLength(1);
    expect(await repo.listByStatus("queued", 1)).toHaveLength(0);
    await repo.updateStatus("s1", "running");
    expect((await repo.get("s1"))?.status).toBe("running");
    await expect(repo.updateStatus("x", "failed")).rejects.toThrow(/not found/);
  });
});

describe("MemoryWorktreeRepository", () => {
  it("claims exclusively and releases", async () => {
    const repo = new MemoryWorktreeRepository();
    repo.seed({
      id: "wt-1",
      name: "wt-1",
      hostId: "a1",
      repositoryId: "r1",
      path: "/w",
      labels: ["codex"],
      status: "idle",
      online: true,
    });
    expect(
      await repo.tryClaim({
        worktreeId: "wt-1",
        sessionId: "s1",
        now: "t",
      }),
    ).toBe(true);
    expect(
      await repo.tryClaim({
        worktreeId: "wt-1",
        sessionId: "s2",
        now: "t2",
      }),
    ).toBe(false);
    expect(await repo.listIdleForRepo("r1")).toHaveLength(0);
    await repo.release("wt-1");
    expect(await repo.listIdleForRepo("r1")).toHaveLength(1);
    await repo.release("missing");
    expect(
      await repo.tryClaim({
        worktreeId: "missing",
        sessionId: "s",
        now: "t",
      }),
    ).toBe(false);
  });
});
