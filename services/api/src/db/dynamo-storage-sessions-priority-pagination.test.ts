import { beforeEach, describe, expect, it } from "vitest";

import { ControlPlane } from "../control-plane.ts";
import { compareSessions } from "../control-plane-session-order.ts";
import type { SessionRecord } from "./types.ts";
import { createDynamoTestCtx } from "./dynamo-test-helpers.ts";

const dynamo = createDynamoTestCtx("PriorityPage");

beforeEach(async () => {
  if (!dynamo.available || !dynamo.storage) return;
  await dynamo.storage.clearAll();
  await Promise.all(rows.map((row) => dynamo.storage!.putSession(row)));
});

const rows: SessionRecord[] = [
  session("a-high", "repo-a", "queued", 1, 10, "2026-01-01T00:00:03.000Z"),
  session("a-zero", "repo-a", "running", 0, 0, "2026-01-01T00:00:02.000Z"),
  session("a-tie-z", "repo-a", "failed", 1, 0, "2026-01-01T00:00:02.000Z"),
  session("a-tie-a", "repo-a", "cancelled", 0, 0, "2026-01-01T00:00:02.000Z"),
  session("a-low", "repo-a", "completed", 1, -10, "2026-01-01T00:00:01.000Z"),
  session("a-timeout", "repo-a", "timed_out", 0, -10, "2026-01-01T00:00:00.000Z"),
  session("b-high", "repo-b", "queued", 0, 100, "2026-01-01T00:00:04.000Z"),
];

describe("DynamoDB Local durable session priority pagination", () => {
  it("returns every repository-scoped status/shard row in exact priority order", async () => {
    if (!dynamo.available || !dynamo.storage) {
      expect(true).toBe(true);
      return;
    }
    const plane = new ControlPlane({
      storage: dynamo.storage,
      shardCount: 2,
      sessionCursorSecret: "priority-pagination-test",
    });
    const expectedRows = rows
      .filter((row) => row.repositoryId === "repo-a")
      .toSorted((a, b) => compareSessions(a, b, "priority_desc"));

    for (const sort of ["priority_desc", "priority_asc"] as const) {
      const expected = expectedRows.toSorted((a, b) => compareSessions(a, b, sort));
      const actual: string[] = [];
      let cursor: string | undefined;
      for (let pageNumber = 0; ; pageNumber += 1) {
        if (pageNumber > expected.length + 1)
          throw new Error("cursor pagination did not terminate");
        const page = await plane.listSessionsPageDurable({
          repositoryId: "repo-a",
          status: "all",
          sort,
          limit: 2,
          ...(cursor ? { cursor } : {}),
        });
        actual.push(...page.items.map((item) => item.id));
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      expect(actual).toEqual(expected.map((row) => row.id));
      expect(new Set(actual).size).toBe(actual.length);
    }
  });

  it("keeps repository identity as an explicit filter after indexed reads", async () => {
    if (!dynamo.available || !dynamo.storage) {
      expect(true).toBe(true);
      return;
    }
    const plane = new ControlPlane({
      storage: dynamo.storage,
      shardCount: 2,
      sessionCursorSecret: "priority-pagination-test",
    });
    const page = await plane.listSessionsPageDurable({
      repositoryId: "repo-a",
      status: "queued",
      sort: "priority_desc",
      limit: 10,
    });
    expect(page.items.map((item) => item.id)).toEqual(["a-high"]);
  });
});

function session(
  id: string,
  repositoryId: string,
  status: SessionRecord["status"],
  queueShard: number,
  priority: number,
  createdAt: string,
): SessionRecord {
  return {
    id,
    repositoryId,
    prompt: "priority pagination",
    target: { commandId: "command" },
    fallbacks: [],
    targetDisplayNames: ["command"],
    queueTtlSeconds: 60,
    queueExpiresAt: "2026-01-01T01:00:00.000Z",
    timeout: 60,
    priority,
    requiredLabels: [],
    status,
    queueShard,
    createdAt,
    source: "api",
    type: "prompt",
  };
}
