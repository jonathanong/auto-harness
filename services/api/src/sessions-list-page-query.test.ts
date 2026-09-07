import { QueryCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";

import { listSessionsPageFromStorage } from "./db/plane-storage-sessions-list-page.ts";
import type { PlaneStorageCtx } from "./db/plane-storage-types.ts";

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
    expect(page.map((session) => session.id)).toEqual(["sess-1"]);
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

  it("binds createdAt on follow-up pages and uses the queue-order index for priority sorts", async () => {
    const commands: QueryCommand[] = [];
    const ctx = {
      doc: {
        send: async (command: QueryCommand) => {
          commands.push(command);
          return {
            Items: [],
            LastEvaluatedKey: commands.length === 1 ? { id: "more" } : undefined,
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
    expect(commands[0]?.input.IndexName).toBe("statusShard-queueOrder");
    expect(commands[0]?.input.ExpressionAttributeNames).toEqual({ "#key": "statusShard" });
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
    ).resolves.toEqual([]);
  });
});
