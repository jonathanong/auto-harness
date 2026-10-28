/* eslint-disable max-lines -- one Query fake serves every one-partition plan case. */
import type { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";

import type { SessionCursorV2 } from "../control-plane-session-cursor.ts";
import { legacyPartitionPlan, singlePartition } from "./plane-storage-sessions-list-plan.ts";
import {
  listSessionsPageFromStorage,
  type SessionListPageQuery,
} from "./plane-storage-sessions-list-page.ts";
import { sessionToItem, type PlaneStorageCtx } from "./plane-storage-types.ts";
import type { SessionRecord } from "./types.ts";

const baseQuery: SessionListPageQuery = {
  limit: 3,
  sort: "latest",
  shardCount: 2,
  status: null,
  repositoryId: null,
  repositoryIds: null,
  hostId: null,
  source: null,
  concurrencyId: null,
  scheduleId: null,
};

function session(index: number, overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: `s-${String(index).padStart(2, "0")}`,
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
    status: index % 2 === 0 ? "completed" : "queued",
    queueShard: index % 2,
    createdAt: `2026-01-01T00:${String(index).padStart(2, "0")}:00.000Z`,
    source: "ui",
    type: "prompt",
    ...overrides,
  };
}

/**
 * A Query fake over real `sessionToItem` rows: any GSI hash key, either direction, paged.
 * `responseCap` stands in for DynamoDB's 1MB response limit, in rows.
 */
function fakeDynamo(
  sessions: readonly SessionRecord[],
  ready: boolean | "stale",
  responseCap = Number.POSITIVE_INFINITY,
) {
  const items = sessions.map((record) => sessionToItem(record));
  const queries: QueryCommand["input"][] = [];
  let marked = false;
  const ctx = {
    doc: {
      send: async (command: QueryCommand) => {
        queries.push(command.input);
        const hashName = command.input.KeyConditionExpression!.split(" = ")[0]!;
        const key = command.input.ExpressionAttributeValues![":key"];
        const forward = command.input.ScanIndexForward !== false;
        const partition = items
          .filter((item) => item[hashName] === key)
          .toSorted((a, b) =>
            forward
              ? String(a.createdOrder).localeCompare(String(b.createdOrder))
              : String(b.createdOrder).localeCompare(String(a.createdOrder)),
          );
        const start = command.input.ExclusiveStartKey
          ? partition.findIndex((item) => item.id === command.input.ExclusiveStartKey!.id) + 1
          : 0;
        const page = partition.slice(start, start + Math.min(command.input.Limit!, responseCap));
        const last = page.at(-1);
        return {
          Items: page,
          ...(start + page.length < partition.length && last
            ? {
                LastEvaluatedKey: {
                  id: last.id,
                  [hashName]: key,
                  createdOrder: last.createdOrder,
                },
              }
            : {}),
        };
      },
    },
    tables: { sessions: "sessions" },
    sessionListIndexes: {
      ready: async () => ready === true,
      markReady: () => {
        marked = true;
      },
    },
  } as unknown as PlaneStorageCtx;
  return { ctx, queries, wasMarkedReady: () => marked };
}

function continuationQuery(
  query: SessionListPageQuery,
  partitions: SessionCursorV2["partitions"],
  last: SessionRecord,
): SessionListPageQuery {
  return {
    ...query,
    position: { createdAt: last.createdAt, id: last.id, priority: last.priority },
    continuation: {
      version: 2,
      sort: query.sort,
      query: {
        repositoryId: query.repositoryId,
        status: query.status,
        hostId: null,
        concurrencyId: null,
        scheduleId: null,
        source: null,
      },
      scopeHash: "scope",
      partitions,
    },
  };
}

const many = Array.from({ length: 8 }, (_, index) =>
  session(index, { worktreeId: "wt-1", resolvedRoute: route("wt-1") }),
);

function route(worktreeId: string | null): SessionRecord["resolvedRoute"] {
  return {
    targetIndex: 0,
    commandId: "cmd",
    hostId: "host",
    worktreeId,
    attemptId: "attempt",
  };
}

describe("one-partition plan selection", () => {
  it("prefers the worktree index, then the repository index, then the global index", () => {
    expect(
      singlePartition({ ...baseQuery, worktreeId: "wt", repositoryId: "repo-1" }),
    ).toMatchObject({
      id: "routeWorktreeId:wt",
      indexName: "routeWorktreeId-createdOrder",
      keyName: "routeWorktreeId",
      keyValue: "wt",
      sortKeyName: "createdOrder",
      forward: false,
    });
    expect(singlePartition({ ...baseQuery, repositoryId: "repo-1", sort: "oldest" })).toMatchObject(
      {
        id: "repositoryId:repo-1",
        indexName: "repositoryId-createdOrder",
        forward: true,
      },
    );
    expect(singlePartition(baseQuery)).toMatchObject({
      id: "sessionList:all",
      indexName: "sessionList-createdOrder",
      keyName: "sessionList",
      keyValue: "all",
    });
  });

  it("keeps status partitions for status, host, source, schedule, concurrency and scope filters", () => {
    for (const narrowed of [
      { status: "queued" as const },
      { hostId: "host" },
      { source: "ui" },
      { concurrencyId: "c" },
      { scheduleId: "sch" },
      { repositoryIds: ["repo-1"] },
    ]) {
      expect(singlePartition({ ...baseQuery, ...narrowed })).toBeUndefined();
      expect(legacyPartitionPlan({ ...baseQuery, ...narrowed }).length).toBeGreaterThan(0);
    }
  });

  it("still narrows to the repository or worktree index when other filters are set", () => {
    expect(singlePartition({ ...baseQuery, repositoryId: "r", status: "queued" })?.id).toBe(
      "repositoryId:r",
    );
    expect(singlePartition({ ...baseQuery, worktreeId: "w", hostId: "h" })?.id).toBe(
      "routeWorktreeId:w",
    );
  });

  it("leaves priority sorts on the priority partitions", () => {
    expect(singlePartition({ ...baseQuery, sort: "priority_asc" })).toBeUndefined();
    expect(
      singlePartition({ ...baseQuery, sort: "priority_desc", repositoryId: "repo-1" }),
    ).toBeUndefined();
  });

  it("reads 24 legacy partitions at shardCount 4", () => {
    expect(legacyPartitionPlan({ ...baseQuery, shardCount: 4 })).toHaveLength(24);
  });
});

describe("one-partition list reads", () => {
  it("reads a full page and a usable cursor in one Query, then the next page", async () => {
    const { ctx, queries } = fakeDynamo(many, true);
    const first = await listSessionsPageFromStorage(ctx, baseQuery);
    expect(first.items.map((item) => item.id)).toEqual(["s-07", "s-06", "s-05"]);
    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatchObject({ IndexName: "sessionList-createdOrder", Limit: 4 });
    expect(first.continuation).toEqual([
      {
        id: "sessionList:all",
        checkpoint: {
          id: "s-05",
          sessionList: "all",
          createdOrder: "2026-01-01T00:05:00.000Z#s-05",
        },
        exhausted: false,
      },
    ]);
    const second = await listSessionsPageFromStorage(
      ctx,
      continuationQuery(baseQuery, first.continuation!, first.items.at(-1)!),
    );
    expect(second.items.map((item) => item.id)).toEqual(["s-04", "s-03", "s-02"]);
    expect(queries).toHaveLength(2);
    expect(queries[1]!.ExclusiveStartKey).toMatchObject({ id: "s-05" });
    const third = await listSessionsPageFromStorage(
      ctx,
      continuationQuery(baseQuery, second.continuation!, second.items.at(-1)!),
    );
    expect(third.items.map((item) => item.id)).toEqual(["s-01", "s-00"]);
    expect(third.continuation).toBeNull();
  });

  it("continues a Query cut short by the response size until the page is full", async () => {
    const { ctx, queries } = fakeDynamo(many, true, 2);
    const page = await listSessionsPageFromStorage(ctx, baseQuery);
    expect(page.items.map((item) => item.id)).toEqual(["s-07", "s-06", "s-05"]);
    expect(queries.map((query) => query.Limit)).toEqual([4, 2]);
    expect(queries[1]!.ExclusiveStartKey).toMatchObject({ id: "s-06" });
    expect(page.continuation).not.toBeNull();
  });

  it("walks the repository and worktree indexes, hiding later-disconnected sessions' siblings", async () => {
    const other = session(20, { repositoryId: "repo-2" });
    const disconnected = session(21, {
      worktreeId: null,
      resolvedRoute: route("wt-1"),
    });
    const { ctx, queries } = fakeDynamo([...many, other, disconnected], true);
    const repo = await listSessionsPageFromStorage(ctx, {
      ...baseQuery,
      limit: 20,
      repositoryId: "repo-1",
      sort: "oldest",
    });
    expect(repo.items.map((item) => item.id)).toEqual(
      [...many, disconnected].map((item) => item.id),
    );
    expect(queries.at(-1)).toMatchObject({ IndexName: "repositoryId-createdOrder" });
    const worktree = await listSessionsPageFromStorage(ctx, {
      ...baseQuery,
      limit: 20,
      worktreeId: "wt-1",
      repositoryId: "repo-1",
    });
    expect(worktree.items.map((item) => item.id)).toContain("s-21");
    expect(worktree.items).toHaveLength(9);
    expect(queries.at(-1)).toMatchObject({ IndexName: "routeWorktreeId-createdOrder" });
    expect(worktree.continuation).toBeNull();
  });

  it("falls back to the status partitions until the indexes are ready", async () => {
    const { ctx, queries } = fakeDynamo(many, false);
    await listSessionsPageFromStorage(ctx, baseQuery);
    expect(queries).toHaveLength(12);
    expect(queries.every((query) => query.IndexName === "statusShard-createdOrder")).toBe(true);
    const absent = fakeDynamo(many, true);
    delete (absent.ctx as { sessionListIndexes?: unknown }).sessionListIndexes;
    await listSessionsPageFromStorage(absent.ctx, baseQuery);
    expect(absent.queries).toHaveLength(12);
  });

  it("keeps serving a legacy cursor with the legacy plan after the indexes become ready", async () => {
    const notReady = fakeDynamo(many, false);
    const first = await listSessionsPageFromStorage(notReady.ctx, baseQuery);
    expect(first.continuation).toHaveLength(12);
    const ready = fakeDynamo(many, true);
    const second = await listSessionsPageFromStorage(
      ready.ctx,
      continuationQuery(baseQuery, first.continuation!, first.items.at(-1)!),
    );
    expect(second.items.map((item) => item.id)).toEqual(["s-04", "s-03", "s-02"]);
    expect(ready.queries).toHaveLength(12);
    expect(ready.wasMarkedReady()).toBe(false);
  });

  it("serves a one-partition cursor even when this instance still believes not ready", async () => {
    const ready = fakeDynamo(many, true);
    const first = await listSessionsPageFromStorage(ready.ctx, baseQuery);
    const stale = fakeDynamo(many, "stale");
    const second = await listSessionsPageFromStorage(
      stale.ctx,
      continuationQuery(baseQuery, first.continuation!, first.items.at(-1)!),
    );
    expect(second.items.map((item) => item.id)).toEqual(["s-04", "s-03", "s-02"]);
    expect(stale.queries).toHaveLength(1);
    expect(stale.wasMarkedReady()).toBe(true);
  });

  it("rejects a cursor that matches neither plan", async () => {
    const { ctx } = fakeDynamo(many, true);
    await expect(
      listSessionsPageFromStorage(
        ctx,
        continuationQuery(
          baseQuery,
          [{ id: "status:bogus:0", checkpoint: null, exhausted: false }],
          many[0]!,
        ),
      ),
    ).rejects.toThrow();
  });

  it("returns an empty page for an empty repository scope", async () => {
    const { ctx, queries } = fakeDynamo(many, true);
    const page = await listSessionsPageFromStorage(ctx, { ...baseQuery, repositoryIds: [] });
    expect(page).toEqual({ items: [], continuation: null });
    expect(queries).toHaveLength(0);
  });
});
