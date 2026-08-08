import { describe, expect, it } from "vitest";

import { compareSessionsForQueue, compareWorktreesForRoundRobin } from "./scheduler.ts";

describe("compare helpers", () => {
  it("orders sessions and worktrees", () => {
    const base = {
      repositoryId: "r",
      prompt: "p",
      commandId: "c",
      targetLabel: "c",
      timeout: 1,
      requiredLabels: [] as string[],
      onConflict: "queue" as const,
      status: "queued" as const,
      queueShard: 0,
    };
    expect(
      compareSessionsForQueue(
        { ...base, id: "a", priority: 1, createdAt: "t1" },
        { ...base, id: "b", priority: 2, createdAt: "t1" },
      ),
    ).toBeGreaterThan(0);
    expect(
      compareSessionsForQueue(
        { ...base, id: "a", priority: 1, createdAt: "t1" },
        { ...base, id: "b", priority: 1, createdAt: "t2" },
      ),
    ).toBeLessThan(0);
    expect(
      compareSessionsForQueue(
        { ...base, id: "a", priority: 1, createdAt: "t" },
        { ...base, id: "b", priority: 1, createdAt: "t" },
      ),
    ).toBeLessThan(0);

    const wt = {
      hostId: "a",
      repositoryId: "r",
      path: "/p",
      labels: [] as string[],
      status: "idle" as const,
      online: true,
    };
    expect(
      compareWorktreesForRoundRobin(
        { ...wt, id: "a", name: "a", lastAssignedAt: null },
        { ...wt, id: "b", name: "b", lastAssignedAt: "t" },
      ),
    ).toBeLessThan(0);
    expect(
      compareWorktreesForRoundRobin(
        { ...wt, id: "b", name: "b", lastAssignedAt: "t" },
        { ...wt, id: "a", name: "a", lastAssignedAt: "t" },
      ),
    ).toBeGreaterThan(0);
    expect(
      compareWorktreesForRoundRobin({ ...wt, id: "a", name: "a" }, { ...wt, id: "b", name: "b" }),
    ).toBeLessThan(0);
  });
});
