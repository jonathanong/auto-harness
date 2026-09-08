/* eslint-disable max-lines -- session page queries share one storage fixture. */
import { QueryCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";

import { InvalidSessionCursorError } from "./control-plane-session-cursor.ts";
import { listSessionsPageFromStorage } from "./db/plane-storage-sessions-list-page.ts";
import type { PlaneStorageCtx } from "./db/plane-storage-types.ts";
import {
  priorityOrderKey,
  repositoryPriorityOrderKey,
  repositoryPriorityOrderRange,
} from "./control-plane-ordering.ts";

function row(id: string, createdAt: string, source = "ui", repositoryId = "repo-1") {
  return {
    id,
    repositoryId,
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
    createdAt,
    source,
    type: "prompt",
  };
}

describe("listSessionsPageFromStorage", () => {
  it("queries status shards instead of scanning the Sessions table", async () => {
    const commands: unknown[] = [];
    const ctx = {
      doc: {
        send: async (command: unknown) => {
          commands.push(command);
          return {
            Items: [
              {
                id: "sess-1",
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
                source: "ui",
                type: "prompt",
              },
            ],
          };
        },
      },
      tables: { sessions: "sessions" },
    } as unknown as PlaneStorageCtx;

    const page = await listSessionsPageFromStorage(ctx, {
      limit: 2,
      sort: "latest",
      shardCount: 1,
      status: "queued",
      repositoryId: null,
      repositoryIds: null,
      hostId: null,
      source: null,
      concurrencyId: null,
      scheduleId: null,
    });
    expect(page.items.map((session) => session.id)).toEqual(["sess-1"]);
    expect(commands).toEqual([expect.any(QueryCommand)]);
    expect(commands.some((command) => command instanceof ScanCommand)).toBe(false);
    expect((commands[0] as QueryCommand).input.Limit).toBe(3);
  });

  it("queries the repository createdAt index when repositoryId is set", async () => {
    const commands: QueryCommand[] = [];
    const ctx = {
      doc: {
        send: async (command: QueryCommand) => {
          commands.push(command);
          return { Items: [] };
        },
      },
      tables: { sessions: "sessions" },
    } as unknown as PlaneStorageCtx;

    await listSessionsPageFromStorage(ctx, {
      limit: 50,
      sort: "oldest",
      shardCount: 4,
      status: null,
      repositoryId: "repo-1",
      repositoryIds: null,
      hostId: null,
      source: null,
      concurrencyId: null,
      scheduleId: null,
    });
    expect(commands).toHaveLength(1);
    expect(commands[0]?.input.IndexName).toBe("repositoryId-createdAt");
    expect(commands[0]?.input.ScanIndexForward).toBe(true);
  });

  it("binds createdAt on follow-up pages and uses the priority index for priority sorts", async () => {
    const commands: QueryCommand[] = [];
    const ctx = {
      doc: {
        send: async (command: QueryCommand) => {
          commands.push(command);
          return {
            Items: [],
          };
        },
      },
      tables: { sessions: "sessions" },
    } as unknown as PlaneStorageCtx;

    await listSessionsPageFromStorage(ctx, {
      limit: 1,
      sort: "latest",
      shardCount: 1,
      status: "running",
      repositoryId: null,
      repositoryIds: null,
      hostId: null,
      source: null,
      concurrencyId: null,
      scheduleId: null,
      position: { createdAt: "2026-01-01T00:00:00.000Z", id: "sess-0", priority: 0 },
    });
    expect(commands[0]?.input.KeyConditionExpression).toContain("createdAt <=");

    commands.length = 0;
    await listSessionsPageFromStorage(ctx, {
      limit: 1,
      sort: "priority_desc",
      shardCount: 1,
      status: "queued",
      repositoryId: null,
      repositoryIds: null,
      hostId: null,
      source: null,
      concurrencyId: null,
      scheduleId: null,
    });
    expect(commands[0]?.input.IndexName).toBe("statusShard-priorityOrder");
    expect(commands[0]?.input.KeyConditionExpression).toBe("statusShard = :key");
    expect(commands[0]?.input.ScanIndexForward).toBe(false);
  });

  it("binds createdAt on oldest follow-up pages and queries each repository id", async () => {
    const commands: QueryCommand[] = [];
    const ctx = {
      doc: {
        send: async (command: QueryCommand) => {
          commands.push(command);
          return {};
        },
      },
      tables: { sessions: "sessions" },
    } as unknown as PlaneStorageCtx;

    await listSessionsPageFromStorage(ctx, {
      limit: 1,
      sort: "oldest",
      shardCount: 1,
      status: "running",
      repositoryId: "repo-1",
      repositoryIds: ["repo-1"],
      hostId: "host-1",
      source: "ui",
      concurrencyId: "c1",
      scheduleId: "s1",
      position: { createdAt: "2026-01-01T00:00:00.000Z", id: "sess-0", priority: 0 },
    });
    expect(commands[0]?.input.KeyConditionExpression).toContain("createdAt >=");
    expect(commands[0]?.input.IndexName).toBe("repositoryId-createdAt");

    commands.length = 0;
    await listSessionsPageFromStorage(ctx, {
      limit: 1,
      sort: "oldest",
      shardCount: 1,
      status: "queued",
      repositoryId: null,
      repositoryIds: ["repo-a", "repo-b"],
      hostId: null,
      source: null,
      concurrencyId: null,
      scheduleId: null,
    });
    expect(commands).toHaveLength(1);
  });

  it("queries every status shard and drops extra-filter and cursor matches", async () => {
    const commands: QueryCommand[] = [];
    const session = {
      id: "sess-0",
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
      source: "api",
      type: "prompt",
      hostId: "host-other",
    };
    const ctx = {
      doc: {
        send: async (command: QueryCommand) => {
          commands.push(command);
          return { Items: [session] };
        },
      },
      tables: { sessions: "sessions" },
    } as unknown as PlaneStorageCtx;

    await listSessionsPageFromStorage(ctx, {
      limit: 1,
      sort: "latest",
      shardCount: 1,
      status: null,
      repositoryId: null,
      repositoryIds: null,
      hostId: null,
      source: null,
      concurrencyId: null,
      scheduleId: null,
    });
    expect(commands.length).toBeGreaterThan(1);

    commands.length = 0;
    await expect(
      listSessionsPageFromStorage(ctx, {
        limit: 1,
        sort: "latest",
        shardCount: 1,
        status: "queued",
        repositoryId: null,
        repositoryIds: ["repo-other"],
        hostId: "host-1",
        source: "ui",
        concurrencyId: "c1",
        scheduleId: "s1",
        position: { createdAt: session.createdAt, id: session.id, priority: 0 },
      }),
    ).resolves.toEqual({ items: [], continuation: null });
  });

  it("returns no rows when a repository filter contradicts the scoped ids", async () => {
    const ctx = {
      doc: { send: async () => ({ Items: [] }) },
      tables: { sessions: "sessions" },
    } as unknown as PlaneStorageCtx;
    await expect(
      listSessionsPageFromStorage(ctx, {
        limit: 10,
        sort: "latest",
        shardCount: 1,
        status: null,
        repositoryId: "repo-1",
        repositoryIds: ["repo-2"],
        hostId: null,
        source: null,
        concurrencyId: null,
        scheduleId: null,
      }),
    ).resolves.toEqual({ items: [], continuation: null });
  });

  it("rechecks repository identity after a scoped priority query", async () => {
    const wrongRepository = {
      id: "wrong-repository-row",
      repositoryId: "repo-other",
      status: "queued",
      queueShard: 0,
      priority: 10,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const ctx = {
      doc: { send: async () => ({ Items: [wrongRepository] }) },
      tables: { sessions: "sessions" },
    } as unknown as PlaneStorageCtx;

    await expect(
      listSessionsPageFromStorage(ctx, {
        limit: 1,
        sort: "priority_desc",
        shardCount: 1,
        status: "queued",
        repositoryId: "repo-expected",
        repositoryIds: null,
        hostId: null,
        source: null,
        concurrencyId: null,
        scheduleId: null,
      }),
    ).resolves.toEqual({ items: [], continuation: null });
  });

  it("keeps extra-filter matches and drops a session at the cursor", async () => {
    const session = {
      id: "sess-1",
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
      createdAt: "2026-01-02T00:00:00.000Z",
      source: "ui",
      type: "prompt",
      hostId: "host-1",
      concurrencyId: "c1",
      scheduleId: "s1",
    };
    const ctx = {
      doc: { send: async () => ({ Items: [session] }) },
      tables: { sessions: "sessions" },
    } as unknown as PlaneStorageCtx;
    const filters = {
      limit: 1,
      sort: "latest" as const,
      shardCount: 1,
      status: "queued" as const,
      repositoryId: null,
      repositoryIds: ["repo-1"],
      hostId: "host-1",
      source: "ui",
      concurrencyId: "c1",
      scheduleId: "s1",
    };
    await expect(listSessionsPageFromStorage(ctx, filters)).resolves.toMatchObject({
      items: [{ id: "sess-1" }],
    });
    await expect(
      listSessionsPageFromStorage(ctx, {
        ...filters,
        position: { createdAt: session.createdAt, id: session.id, priority: 0 },
      }),
    ).resolves.toEqual({ items: [], continuation: null });
  });

  it("keeps a sparse nonmatch continuation and resumes at its exact Dynamo key", async () => {
    const commands: QueryCommand[] = [];
    const skipped = row("skipped", "2026-01-03T00:00:00.000Z", "api");
    const match = row("match", "2026-01-02T00:00:00.000Z");
    const ctx = {
      doc: {
        send: async (command: QueryCommand) => {
          commands.push(command);
          return commands.length === 1
            ? {
                Items: [skipped],
                LastEvaluatedKey: {
                  id: skipped.id,
                  statusShard: "queued#0",
                  createdAt: skipped.createdAt,
                },
              }
            : { Items: [match] };
        },
      },
      tables: { sessions: "sessions" },
    } as unknown as PlaneStorageCtx;
    const query = {
      limit: 1,
      sort: "latest" as const,
      shardCount: 1,
      status: "queued" as const,
      repositoryId: null,
      repositoryIds: null,
      hostId: null,
      source: "ui",
      concurrencyId: null,
      scheduleId: null,
    };
    const first = await listSessionsPageFromStorage(ctx, query);
    expect(first).toMatchObject({ items: [], continuation: [{ checkpoint: expect.any(Object) }] });
    const second = await listSessionsPageFromStorage(ctx, {
      ...query,
      continuation: {
        version: 2,
        sort: "latest",
        query: {
          repositoryId: null,
          status: "queued",
          hostId: null,
          concurrencyId: null,
          scheduleId: null,
          source: "ui",
        },
        scopeHash: "test-scope",
        partitions: first.continuation!,
      },
    });
    expect(second).toMatchObject({ items: [{ id: "match" }], continuation: null });
    expect(commands).toHaveLength(2);
    expect(commands[1]?.input.ExclusiveStartKey).toEqual({
      id: "skipped",
      statusShard: "queued#0",
      createdAt: skipped.createdAt,
    });
  });

  it("advances an empty Dynamo page with LastEvaluatedKey without marking the list terminal", async () => {
    const commands: QueryCommand[] = [];
    const match = row("match", "2026-01-02T00:00:00.000Z");
    const emptyKey = {
      id: "filtered",
      statusShard: "queued#0",
      createdAt: "2026-01-03T00:00:00.000Z",
    };
    const ctx = {
      doc: {
        send: async (command: QueryCommand) => {
          commands.push(command);
          return commands.length === 1
            ? { Items: [], LastEvaluatedKey: emptyKey }
            : { Items: [match] };
        },
      },
      tables: { sessions: "sessions" },
    } as unknown as PlaneStorageCtx;
    const query = {
      limit: 1,
      sort: "latest" as const,
      shardCount: 1,
      status: "queued" as const,
      repositoryId: null,
      repositoryIds: null,
      hostId: null,
      source: null,
      concurrencyId: null,
      scheduleId: null,
    };
    const first = await listSessionsPageFromStorage(ctx, query);
    expect(first.continuation).not.toBeNull();
    const second = await listSessionsPageFromStorage(ctx, {
      ...query,
      continuation: {
        version: 2,
        sort: "latest",
        query: {
          repositoryId: null,
          status: "queued",
          hostId: null,
          concurrencyId: null,
          scheduleId: null,
          source: null,
        },
        scopeHash: "test-scope",
        partitions: first.continuation!,
      },
    });
    expect(second.items.map((item) => item.id)).toEqual(["match"]);
    expect(commands[1]?.input.ExclusiveStartKey).toEqual(emptyKey);
  });

  it("merges only the globally safe prefix while querying each repository partition once", async () => {
    const commands: QueryCommand[] = [];
    const newest = row("newest", "2026-01-03T00:00:00.000Z", "ui", "repo-a");
    const older = row("older", "2026-01-02T00:00:00.000Z", "ui", "repo-b");
    const ctx = {
      doc: {
        send: async (command: QueryCommand) => {
          commands.push(command);
          const repository = command.input.ExpressionAttributeValues?.[":key"];
          const item = repository === "repo-a" ? newest : older;
          return {
            Items: [item],
            LastEvaluatedKey: {
              id: item.id,
              repositoryId: item.repositoryId,
              createdAt: item.createdAt,
            },
          };
        },
      },
      tables: { sessions: "sessions" },
    } as unknown as PlaneStorageCtx;
    const page = await listSessionsPageFromStorage(ctx, {
      limit: 1,
      sort: "latest",
      shardCount: 1,
      status: null,
      repositoryId: null,
      repositoryIds: ["repo-b", "repo-a"],
      hostId: null,
      source: null,
      concurrencyId: null,
      scheduleId: null,
    });
    expect(page.items.map((item) => item.id)).toEqual(["newest"]);
    expect(page.continuation).not.toBeNull();
    expect(commands).toHaveLength(2);
  });

  it("replays equal-createdAt ties exactly once and rejects a topology-mismatched checkpoint", async () => {
    const a = row("a", "2026-01-03T00:00:00.000Z", "ui", "repo-a");
    const b = row("b", "2026-01-03T00:00:00.000Z", "ui", "repo-b");
    const ctx = {
      doc: {
        send: async (command: QueryCommand) => ({
          Items: [command.input.ExpressionAttributeValues?.[":key"] === "repo-a" ? a : b],
        }),
      },
      tables: { sessions: "sessions" },
    } as unknown as PlaneStorageCtx;
    const query = {
      limit: 1,
      sort: "latest" as const,
      shardCount: 1,
      status: null,
      repositoryId: null,
      repositoryIds: ["repo-a", "repo-b"],
      hostId: null,
      source: null,
      concurrencyId: null,
      scheduleId: null,
    };
    const first = await listSessionsPageFromStorage(ctx, query);
    const second = await listSessionsPageFromStorage(ctx, {
      ...query,
      continuation: {
        version: 2,
        sort: "latest",
        query: {
          repositoryId: null,
          status: null,
          hostId: null,
          concurrencyId: null,
          scheduleId: null,
          source: null,
        },
        scopeHash: "test-scope",
        partitions: first.continuation!,
      },
    });
    expect([...first.items, ...second.items].map((item) => item.id)).toEqual(["b", "a"]);
    await expect(
      listSessionsPageFromStorage(ctx, {
        ...query,
        continuation: {
          version: 2,
          sort: "latest",
          query: {
            repositoryId: null,
            status: null,
            hostId: null,
            concurrencyId: null,
            scheduleId: null,
            source: null,
          },
          scopeHash: "test-scope",
          partitions: [{ id: "status:queued:0", checkpoint: null, exhausted: false }],
        },
      }),
    ).rejects.toThrow(InvalidSessionCursorError);
  });

  it("advances only through a consumable raw prefix when equal keys arrive out of id order", async () => {
    const a = row("a", "2026-01-03T00:00:00.000Z");
    const b = row("b", "2026-01-03T00:00:00.000Z");
    const ctx = {
      doc: {
        send: async (command: QueryCommand) =>
          command.input.ExclusiveStartKey ? { Items: [b] } : { Items: [a, b] },
      },
      tables: { sessions: "sessions" },
    } as unknown as PlaneStorageCtx;
    const query = {
      limit: 1,
      sort: "latest" as const,
      shardCount: 1,
      status: "queued" as const,
      repositoryId: null,
      repositoryIds: null,
      hostId: null,
      source: null,
      concurrencyId: null,
      scheduleId: null,
    };

    const first = await listSessionsPageFromStorage(ctx, query);
    expect(first.items.map((item) => item.id)).toEqual(["a"]);
    const second = await listSessionsPageFromStorage(ctx, {
      ...query,
      continuation: {
        version: 2,
        sort: "latest",
        query: {
          repositoryId: null,
          status: "queued",
          hostId: null,
          concurrencyId: null,
          scheduleId: null,
          source: null,
        },
        scopeHash: "test-scope",
        partitions: first.continuation!,
      },
    });
    expect(second.items.map((item) => item.id)).toEqual(["b"]);
  });

  it("uses the priority index and binds unscoped priority cursors", async () => {
    const commands: QueryCommand[] = [];
    const cursor = { createdAt: "2026-01-01T00:00:00.000Z", id: "sess-0", priority: 0 };
    const ctx = {
      doc: {
        send: async (command: QueryCommand) => {
          commands.push(command);
          return { Items: [] };
        },
      },
      tables: { sessions: "sessions" },
    } as unknown as PlaneStorageCtx;

    await listSessionsPageFromStorage(ctx, {
      limit: 1,
      sort: "priority_asc",
      shardCount: 1,
      status: "queued",
      repositoryId: null,
      repositoryIds: null,
      hostId: null,
      source: null,
      concurrencyId: null,
      scheduleId: null,
      position: cursor,
    });

    expect(commands[0]?.input).toMatchObject({
      IndexName: "statusShard-priorityOrder",
      KeyConditionExpression: "statusShard = :key AND priorityOrder > :sortValue",
      ExpressionAttributeValues: {
        ":key": "queued#0",
        ":sortValue": priorityOrderKey(cursor),
      },
      ScanIndexForward: true,
      Limit: 2,
    });
  });

  it("uses the repository priority range for scoped status pages", async () => {
    const commands: QueryCommand[] = [];
    const cursor = { createdAt: "2026-01-01T00:00:00.000Z", id: "sess-0", priority: 0 };
    const session = {
      ...row("sess-1", "2026-01-02T00:00:00.000Z", "ui", "repo-1"),
      priority: -1,
      status: "running" as const,
    };
    const ctx = {
      doc: {
        send: async (command: QueryCommand) => {
          commands.push(command);
          return {
            Items: [session],
            LastEvaluatedKey: {
              id: session.id,
              statusShard: "running#0",
              repositoryPriorityOrder: repositoryPriorityOrderKey("repo-1", session),
            },
          };
        },
      },
      tables: { sessions: "sessions" },
    } as unknown as PlaneStorageCtx;
    const range = repositoryPriorityOrderRange("repo-1");

    await listSessionsPageFromStorage(ctx, {
      limit: 1,
      sort: "priority_desc",
      shardCount: 1,
      status: "running",
      repositoryId: null,
      repositoryIds: ["repo-1"],
      hostId: null,
      source: null,
      concurrencyId: null,
      scheduleId: null,
      position: cursor,
    });

    expect(commands[0]?.input).toMatchObject({
      IndexName: "statusShard-repositoryPriorityOrder",
      KeyConditionExpression:
        "statusShard = :key AND repositoryPriorityOrder BETWEEN :sortStart AND :sortEnd",
      ExpressionAttributeValues: {
        ":key": "running#0",
        ":sortStart": range.start,
        ":sortEnd": repositoryPriorityOrderKey("repo-1", cursor),
      },
      ScanIndexForward: false,
      Limit: 2,
    });
  });

  it("continues priority pages with the exact priority index key", async () => {
    const commands: QueryCommand[] = [];
    const session = { ...row("priority", "2026-01-02T00:00:00.000Z"), priority: 7 };
    const checkpoint = {
      id: session.id,
      statusShard: "queued#0",
      priorityOrder: priorityOrderKey(session),
    };
    const ctx = {
      doc: {
        send: async (command: QueryCommand) => {
          commands.push(command);
          return commands.length === 1
            ? { Items: [session], LastEvaluatedKey: checkpoint }
            : { Items: [] };
        },
      },
      tables: { sessions: "sessions" },
    } as unknown as PlaneStorageCtx;
    const query = {
      limit: 1,
      sort: "priority_asc" as const,
      shardCount: 1,
      status: "queued" as const,
      repositoryId: null,
      repositoryIds: null,
      hostId: null,
      source: null,
      concurrencyId: null,
      scheduleId: null,
    };

    const first = await listSessionsPageFromStorage(ctx, query);
    expect(first).toMatchObject({ items: [{ id: "priority" }] });
    expect(first.continuation?.[0]?.checkpoint).toEqual(checkpoint);
    await listSessionsPageFromStorage(ctx, {
      ...query,
      continuation: {
        version: 2,
        sort: "priority_asc",
        query: {
          repositoryId: null,
          status: "queued",
          hostId: null,
          concurrencyId: null,
          scheduleId: null,
          source: null,
        },
        scopeHash: "test-scope",
        partitions: first.continuation!,
      },
    });
    expect(commands[1]?.input.ExclusiveStartKey).toEqual(checkpoint);
  });
});
