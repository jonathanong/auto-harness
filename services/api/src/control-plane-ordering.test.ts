import { describe, expect, it } from "vitest";

import {
  compareSessionsForQueue,
  compareWorktreesForRoundRobin,
  mergeQueuedShardHeads,
  orderedQueuedSessions,
  queueOrderKey,
  QUEUE_ORDER_PRIORITY_OFFSET,
} from "./control-plane-ordering.ts";
import type { SessionRecord } from "./db/types.ts";

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

  it("encodes queue order so DynamoDB ascending order matches compareSessionsForQueue", () => {
    const high = { id: "later", priority: 10, createdAt: "t2" };
    const low = { id: "earlier", priority: 0, createdAt: "t1" };
    const samePriEarlier = { id: "a", priority: 1, createdAt: "t1" };
    const samePriLater = { id: "b", priority: 1, createdAt: "t1" };
    expect(queueOrderKey(high) < queueOrderKey(low)).toBe(true);
    expect(queueOrderKey(samePriEarlier) < queueOrderKey(samePriLater)).toBe(true);
    expect(
      queueOrderKey({ id: "max", priority: QUEUE_ORDER_PRIORITY_OFFSET, createdAt: "t" }),
    ).toBe("000000000000#t#max");
    expect(
      queueOrderKey({ id: "over", priority: 99_999, createdAt: "t" }).startsWith("000000000000"),
    ).toBe(true);
    expect(
      queueOrderKey({ id: "under", priority: -99_999, createdAt: "t" }).startsWith("020000000000"),
    ).toBe(true);
    expect(
      queueOrderKey({ id: "half", priority: 0.5, createdAt: "t" }) <
        queueOrderKey({ id: "zero", priority: 0, createdAt: "t" }),
    ).toBe(true);
    expect(
      queueOrderKey({ id: "one", priority: 1, createdAt: "t" }) <
        queueOrderKey({ id: "half", priority: 0.5, createdAt: "t" }),
    ).toBe(true);
  });

  it("merges already-sorted shard heads in global priority/FIFO order", () => {
    const shard0 = [
      { id: "low-old", priority: 0, createdAt: "t0" },
      { id: "low-new", priority: 0, createdAt: "t1" },
    ];
    const shard1 = [{ id: "high", priority: 50, createdAt: "t2" }];
    expect(mergeQueuedShardHeads([shard0, shard1]).map((item) => item.id)).toEqual([
      "high",
      "low-old",
      "low-new",
    ]);
    expect(mergeQueuedShardHeads([[], []])).toEqual([]);
  });

  it("groups queued sessions by shard then globally orders them", () => {
    const sessions: SessionRecord[] = [
      session({ id: "s0", queueShard: 0, priority: 0, createdAt: "t0" }),
      session({ id: "s1", queueShard: 1, priority: 9, createdAt: "t1" }),
      session({ id: "running", status: "running", queueShard: 0 }),
      session({ id: "scheduled", type: "scheduled", queueShard: 0, priority: 100 }),
      session({ id: "oob", queueShard: 9, priority: 100 }),
    ];
    expect(orderedQueuedSessions(sessions, 2, "prompt").map((item) => item.id)).toEqual([
      "s1",
      "s0",
    ]);
    expect(orderedQueuedSessions(sessions, 2, "scheduled").map((item) => item.id)).toEqual([
      "scheduled",
    ]);
  });
});

function session(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "s",
    repositoryId: "repo",
    prompt: "p",
    target: { commandId: "cmd" },
    fallbacks: [],
    targetLabels: ["cmd"],
    queueTtlSeconds: 60,
    queueExpiresAt: "t",
    timeout: 1,
    priority: 0,
    requiredLabels: [],
    status: "queued",
    queueShard: 0,
    createdAt: "t",
    type: "prompt",
    ...over,
  };
}
