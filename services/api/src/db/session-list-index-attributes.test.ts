import { describe, expect, it, vi } from "vitest";

import { routeWorktreeIdOf, sessionInWorktree } from "../control-plane-ordering.ts";
import { itemToSession, sessionToItem } from "./plane-storage-types.ts";
import { SessionListIndexReadiness } from "./session-list-index-readiness.ts";
import type { SessionRecord } from "./types.ts";

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "s-1",
    repositoryId: "repo-1",
    prompt: "work",
    target: { commandId: "cmd" },
    fallbacks: [],
    targetDisplayNames: ["cmd"],
    queueTtlSeconds: 1,
    queueExpiresAt: "2026-01-02T00:00:00.000Z",
    timeout: 1,
    priority: 0,
    requiredLabels: [],
    status: "queued",
    queueShard: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function routed(worktreeId: string | null): SessionRecord["resolvedRoute"] {
  return { targetIndex: 0, commandId: "cmd", hostId: "h", worktreeId, attemptId: "a" };
}

describe("session list index attributes", () => {
  it("writes sessionList on every item and routeWorktreeId from the route", () => {
    const item = sessionToItem(session({ resolvedRoute: routed("wt-1"), worktreeId: null }));
    expect(item).toMatchObject({ sessionList: "all", routeWorktreeId: "wt-1", worktreeId: null });
  });

  it.each([
    ["no route", undefined],
    ["a null route worktree", routed(null)],
    ["an empty route worktree", routed("")],
  ])("omits routeWorktreeId for %s", (_label, resolvedRoute) => {
    const item = sessionToItem(session({ resolvedRoute }));
    expect(item.sessionList).toBe("all");
    expect(item).not.toHaveProperty("routeWorktreeId");
  });

  it("strips both attributes when hydrating, so they never reach the API", () => {
    const hydrated = itemToSession(
      sessionToItem(session({ resolvedRoute: routed("wt-1"), worktreeId: "wt-1" })),
    );
    expect(hydrated).not.toHaveProperty("sessionList");
    expect(hydrated).not.toHaveProperty("routeWorktreeId");
    expect(hydrated.worktreeId).toBe("wt-1");
  });

  it("defines the worktree filter as routed-to or currently-on", () => {
    expect(routeWorktreeIdOf({ resolvedRoute: routed("wt-1") })).toBe("wt-1");
    expect(routeWorktreeIdOf({})).toBeUndefined();
    expect(
      sessionInWorktree(session({ resolvedRoute: routed("wt-1"), worktreeId: null }), "wt-1"),
    ).toBe(true);
    expect(sessionInWorktree(session({ worktreeId: "wt-1" }), "wt-1")).toBe(true);
    expect(
      sessionInWorktree(session({ resolvedRoute: routed("wt-2"), worktreeId: null }), "wt-1"),
    ).toBe(false);
  });
});

describe("SessionListIndexReadiness", () => {
  const tables = { sessionDrains: "drains" };

  it("caches a positive marker for good", async () => {
    const send = vi.fn().mockResolvedValue({ Item: { recordType: "session-list-indexes-v1" } });
    const readiness = new SessionListIndexReadiness({ send } as never, tables);
    await expect(readiness.ready()).resolves.toBe(true);
    await expect(readiness.ready()).resolves.toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0].input).toMatchObject({
      TableName: "drains",
      Key: { scopeKey: "__session-list-indexes__", recordKey: "READY-V1" },
      ConsistentRead: true,
    });
  });

  it("re-probes a missing marker at most every 30 seconds", async () => {
    let now = 1_000;
    const send = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValue({
        Item: { recordType: "session-list-indexes-v1" },
      });
    const readiness = new SessionListIndexReadiness({ send } as never, tables, () => now);
    await expect(readiness.ready()).resolves.toBe(false);
    now += 29_000;
    await expect(readiness.ready()).resolves.toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
    now += 2_000;
    await expect(readiness.ready()).resolves.toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("treats a failed probe as not ready, and a cursor can mark it ready", async () => {
    const send = vi.fn().mockRejectedValue(new Error("throttled"));
    const readiness = new SessionListIndexReadiness({ send } as never, tables);
    await expect(readiness.ready()).resolves.toBe(false);
    readiness.markReady();
    await expect(readiness.ready()).resolves.toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
