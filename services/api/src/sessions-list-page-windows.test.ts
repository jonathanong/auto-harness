import type { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";

import { createdOrderKey } from "./control-plane-ordering.ts";
import { initialWindowLimit } from "./db/plane-storage-sessions-list-window.ts";
import {
  listSessionsPageFromStorage,
  type SessionListPageQuery,
} from "./db/plane-storage-sessions-list-page.ts";
import type { PlaneStorageCtx } from "./db/plane-storage-types.ts";

type Row = Record<string, unknown> & { id: string; createdAt: string; statusShard: string };

function row(id: string, minute: number, status: string, worktreeId = "wt-other"): Row {
  const createdAt = `2026-01-01T00:${String(minute).padStart(2, "0")}:00.000Z`;
  return {
    id,
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
    status,
    queueShard: 0,
    createdAt,
    source: "ui",
    type: "prompt",
    worktreeId,
    statusShard: `${status}#0`,
    createdOrder: createdOrderKey({ createdAt, id }),
  };
}

/** A DynamoDB Query fake: newest-first, honours Limit and ExclusiveStartKey. */
function fakeDynamo(rows: readonly Row[]) {
  const limits: Array<[string, number]> = [];
  const ctx = {
    doc: {
      send: async (command: QueryCommand) => {
        const key = command.input.ExpressionAttributeValues?.[":key"] as string;
        const limit = command.input.Limit!;
        limits.push([key, limit]);
        const partition = rows
          .filter((candidate) => candidate.statusShard === key)
          .toSorted((a, b) => String(b.createdOrder).localeCompare(String(a.createdOrder)));
        const startKey = command.input.ExclusiveStartKey;
        const bound = command.input.ExpressionAttributeValues?.[":sortValue"];
        if (startKey && bound !== undefined && startKey.createdOrder > bound) {
          // DynamoDB rejects a start key outside the key condition.
          throw new Error("The provided starting key does not match the range key predicate");
        }
        const startId = startKey?.id;
        const start = startId ? partition.findIndex((r) => r.id === startId) + 1 : 0;
        const items = partition.slice(start, start + limit);
        const last = items.at(-1);
        return {
          Items: items,
          ...(items.length === limit && last
            ? {
                LastEvaluatedKey: {
                  id: last.id,
                  statusShard: key,
                  createdOrder: last.createdOrder,
                },
              }
            : {}),
        };
      },
    },
    tables: { sessions: "sessions" },
  } as unknown as PlaneStorageCtx;
  return { ctx, limits };
}

const baseQuery: SessionListPageQuery = {
  limit: 10,
  sort: "latest",
  shardCount: 1,
  status: null,
  repositoryId: null,
  repositoryIds: null,
  hostId: null,
  source: null,
  concurrencyId: null,
  scheduleId: null,
};

async function walk(
  ctx: PlaneStorageCtx,
  query: SessionListPageQuery,
): Promise<{ pages: string[][]; ids: string[] }> {
  const pages: string[][] = [];
  let continuation: SessionListPageQuery["continuation"];
  let position: SessionListPageQuery["position"];
  for (let page = 0; page < 50; page++) {
    const result = await listSessionsPageFromStorage(ctx, {
      ...query,
      ...(position ? { position } : {}),
      ...(continuation ? { continuation } : {}),
    });
    pages.push(result.items.map((item) => item.id));
    const last = result.items.at(-1);
    if (last) position = { createdAt: last.createdAt, id: last.id, priority: last.priority };
    if (result.continuation === null) return { pages, ids: pages.flat() };
    continuation = {
      version: 2,
      sort: query.sort,
      query: {
        repositoryId: null,
        status: query.status,
        hostId: null,
        concurrencyId: null,
        scheduleId: null,
        source: null,
      },
      scopeHash: "test-scope",
      partitions: result.continuation,
    };
  }
  throw new Error("pagination did not terminate");
}

describe("windowed session list reads", () => {
  it("sizes the first window as an even share of the page, capped at limit + 1", () => {
    expect(initialWindowLimit(100, 24)).toBe(6);
    expect(initialWindowLimit(10, 6)).toBe(3);
    expect(initialWindowLimit(1, 2)).toBe(2);
    expect(initialWindowLimit(5, 1)).toBe(6);
  });

  it("refills only the partition holding the page back, doubling up to limit + 1", async () => {
    const rows = Array.from({ length: 15 }, (_, index) =>
      row(`c-${index}`, 59 - index, "completed"),
    );
    const { ctx, limits } = fakeDynamo(rows);
    const page = await listSessionsPageFromStorage(ctx, baseQuery);

    expect(page.items.map((item) => item.id)).toEqual(rows.slice(0, 10).map((r) => r.id));
    expect(page.continuation).not.toBeNull();
    // Six status partitions open with ceil(10 / 6) + 1 = 3 rows each; only the
    // completed partition has more, so only it is refilled: 3 + 3 + 5 = 11.
    expect(limits.filter(([key]) => key !== "completed#0")).toHaveLength(5);
    expect(limits.filter(([key]) => key === "completed#0").map(([, limit]) => limit)).toEqual([
      3, 3, 5,
    ]);
  });

  it("stops refilling a partition whose frontier is past the page", async () => {
    const recent = Array.from({ length: 12 }, (_, index) =>
      row(`f-${index}`, 59 - index, "failed"),
    );
    const old = Array.from({ length: 12 }, (_, index) =>
      row(`c-${index}`, 20 - index, "completed"),
    );
    const { ctx, limits } = fakeDynamo([...recent, ...old]);
    const page = await listSessionsPageFromStorage(ctx, baseQuery);

    expect(page.items.map((item) => item.id)).toEqual(recent.slice(0, 10).map((r) => r.id));
    // Both open with 3 rows; neither yet shows 10 matches, so both refill once. Then
    // the completed frontier is past the 10th match and only failed keeps reading.
    expect(limits.filter(([key]) => key === "completed#0").map(([, limit]) => limit)).toEqual([
      3, 3,
    ]);
    expect(limits.filter(([key]) => key === "failed#0").map(([, limit]) => limit)).toEqual([
      3, 3, 5,
    ]);
  });

  it("walks every page of a skewed list in order without duplicates", async () => {
    const statuses = ["completed", "failed", "queued", "running", "cancelled"];
    const rows = Array.from({ length: 47 }, (_, index) =>
      row(`s-${index}`, 59 - index, statuses[index % 7 === 0 ? index % 5 : 0]!),
    );
    const { ctx } = fakeDynamo(rows);
    const { pages, ids } = await walk(ctx, { ...baseQuery, limit: 7 });

    expect(ids).toEqual(rows.map((r) => r.id));
    expect(pages.slice(0, -1).every((page) => page.length === 7)).toBe(true);
  });

  it("ends a sparse filter's page within the read cap and resumes it", async () => {
    const rows = Array.from({ length: 40 }, (_, index) =>
      row(`s-${index}`, 59 - index, "completed", index % 13 === 5 ? "wt-1" : "wt-other"),
    );
    const { ctx, limits } = fakeDynamo(rows);
    const query = { ...baseQuery, limit: 2, worktreeId: "wt-1" };
    const first = await listSessionsPageFromStorage(ctx, query);
    const completedReads = limits
      .filter(([key]) => key === "completed#0")
      .reduce((sum, [, limit]) => sum + limit, 0);
    expect(completedReads).toBeLessThanOrEqual(query.limit + 1);
    expect(first.continuation).not.toBeNull();

    const { ids } = await walk(fakeDynamo(rows).ctx, query);
    expect(ids).toEqual(["s-5", "s-18", "s-31"]);
  });
});
