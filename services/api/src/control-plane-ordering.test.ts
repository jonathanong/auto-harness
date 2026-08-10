import { describe, expect, it } from "vitest";

import {
  compareSessionsForQueue,
  compareWorktreesForRoundRobin,
} from "./control-plane-ordering.ts";

describe("compare helpers", () => {
  it("orders sessions and worktrees", () => {
    expect(
      compareSessionsForQueue(
        { id: "a", priority: 1, createdAt: "t1" },
        { id: "b", priority: 2, createdAt: "t1" },
      ),
    ).toBeGreaterThan(0);
    expect(
      compareSessionsForQueue(
        { id: "a", priority: 1, createdAt: "t1" },
        { id: "b", priority: 1, createdAt: "t2" },
      ),
    ).toBeLessThan(0);
    expect(
      compareSessionsForQueue(
        { id: "a", priority: 1, createdAt: "t" },
        { id: "b", priority: 1, createdAt: "t" },
      ),
    ).toBeLessThan(0);

    expect(
      compareWorktreesForRoundRobin(
        { id: "a", lastAssignedAt: null },
        { id: "b", lastAssignedAt: "t" },
      ),
    ).toBeLessThan(0);
    expect(
      compareWorktreesForRoundRobin(
        { id: "b", lastAssignedAt: "t" },
        { id: "a", lastAssignedAt: "t" },
      ),
    ).toBeGreaterThan(0);
    expect(compareWorktreesForRoundRobin({ id: "a" }, { id: "b" })).toBeLessThan(0);
  });
});
