import { beforeEach, describe, expect, it } from "vitest";

import { ControlPlane } from "../control-plane.ts";
import { compareSessions } from "../control-plane-session-order.ts";
import type { SessionRecord } from "./types.ts";
import { createDynamoTestCtx } from "../../test-helpers/dynamo-test-helpers.ts";

const dynamo = createDynamoTestCtx("WindowedPage");

// Mostly completed rows spread over every shard, with a few in other statuses: the
// shape production lists have, where windowed reads must refill a few partitions.
const statuses = ["queued", "running", "failed", "cancelled", "timed_out"] as const;
const rows: SessionRecord[] = Array.from({ length: 45 }, (_, index) =>
  session(
    `s-${String(index).padStart(2, "0")}`,
    index % 6 === 0 ? statuses[index % 5]! : "completed",
    index % 4,
    new Date(Date.UTC(2026, 0, 1, 0, 0, 59 - index)).toISOString(),
    index % 9 === 4 ? "wt-1" : "wt-other",
  ),
);

beforeEach(async () => {
  if (!dynamo.available || !dynamo.storage) return;
  await dynamo.storage.clearAll();
  await Promise.all(rows.map((row) => dynamo.storage!.putSession(row)));
});

describe("DynamoDB Local windowed session pagination", () => {
  it.each([
    ["latest", 7, undefined],
    ["oldest", 10, undefined],
    ["latest", 2, "wt-1"],
  ] as const)("pages %s order at limit %i (worktree %s) exactly once", async (sort, limit, wt) => {
    if (!dynamo.available || !dynamo.storage) {
      expect(true).toBe(true);
      return;
    }
    const plane = new ControlPlane({
      storage: dynamo.storage,
      shardCount: 4,
      sessionCursorSecret: "windowed-pagination-test",
    });
    const expected = rows
      .filter((row) => wt === undefined || row.worktreeId === wt)
      .toSorted((a, b) => compareSessions(a, b, sort))
      .map((row) => row.id);
    const pages: string[][] = [];
    let cursor: string | undefined;
    for (;;) {
      if (pages.length > rows.length) throw new Error("cursor pagination did not terminate");
      const page = await plane.listSessionsPageDurable({
        sort,
        limit,
        ...(wt ? { worktreeId: wt } : {}),
        ...(cursor ? { cursor } : {}),
      });
      pages.push(page.items.map((item) => item.id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(pages.flat()).toEqual(expected);
    if (wt === undefined) {
      // Unfiltered pages fill completely; only the last may be short.
      expect(pages.slice(0, -1).every((page) => page.length === limit)).toBe(true);
    }
  });
});

function session(
  id: string,
  status: SessionRecord["status"],
  queueShard: number,
  createdAt: string,
  worktreeId: string,
): SessionRecord {
  return {
    id,
    repositoryId: "repo-a",
    prompt: "windowed pagination",
    target: { commandId: "command" },
    fallbacks: [],
    targetDisplayNames: ["command"],
    queueTtlSeconds: 60,
    queueExpiresAt: "2026-01-01T01:00:00.000Z",
    timeout: 60,
    priority: 0,
    requiredLabels: [],
    status,
    queueShard,
    createdAt,
    worktreeId,
    source: "api",
    type: "prompt",
  };
}
