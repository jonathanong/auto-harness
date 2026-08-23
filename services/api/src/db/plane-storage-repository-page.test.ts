import { BatchGetCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";

import { listRepositoriesPage } from "./plane-storage-catalog.ts";
import type { PlaneStorageCtx, RepositoryRecord } from "./plane-storage-types.ts";

function repository(id: string): RepositoryRecord {
  return {
    id,
    name: id,
    url: `https://example.test/${id}`,
    defaultBranch: "main",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function context(send: ReturnType<typeof vi.fn>): PlaneStorageCtx {
  return {
    doc: { send } as never,
    tables: { repositories: "Repositories" } as never,
  };
}

describe("Dynamo repository pages", () => {
  it("uses a bounded strongly consistent table scan and its opaque continuation", async () => {
    const send = vi.fn().mockResolvedValue({
      Items: [repository("alpha"), repository("bravo")],
      LastEvaluatedKey: { id: "bravo" },
    });

    await expect(
      listRepositoriesPage(context(send), {
        limit: 1,
        startKey: { id: "before-alpha" },
      }),
    ).resolves.toEqual({ items: [repository("alpha")], nextKey: { id: "alpha" } });

    const command = send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(ScanCommand);
    expect(command.input).toMatchObject({
      TableName: "Repositories",
      ConsistentRead: true,
      Limit: 2,
      ExclusiveStartKey: { id: "before-alpha" },
    });
  });

  it("reads only one bounded slice of a restricted scope with strong keyed reads", async () => {
    const send = vi.fn().mockResolvedValue({
      Responses: { Repositories: [repository("bravo")] },
    });

    await expect(
      listRepositoriesPage(context(send), {
        limit: 2,
        startKey: { scopeOffset: "invalid" },
        allowedRepositoryIds: ["alpha", "bravo", "charlie"],
      }),
    ).resolves.toEqual({
      items: [repository("bravo")],
      nextKey: { scopeOffset: 2 },
    });

    const command = send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(BatchGetCommand);
    expect(command.input).toEqual({
      RequestItems: {
        Repositories: {
          Keys: [{ id: "alpha" }, { id: "bravo" }],
          ConsistentRead: true,
        },
      },
    });
  });

  it("replays a restricted offset, restores id order, and exhausts the scope", async () => {
    const send = vi.fn().mockResolvedValue({
      Responses: { Repositories: [repository("charlie"), repository("bravo")] },
    });

    await expect(
      listRepositoriesPage(context(send), {
        limit: 2,
        startKey: { scopeOffset: 1 },
        allowedRepositoryIds: ["alpha", "bravo", "charlie"],
      }),
    ).resolves.toEqual({
      items: [repository("bravo"), repository("charlie")],
      nextKey: null,
    });
  });

  it("short-circuits exhausted scopes and fails retryably on unprocessed keys", async () => {
    const emptySend = vi.fn();
    await expect(
      listRepositoriesPage(context(emptySend), { limit: 1, allowedRepositoryIds: [] }),
    ).resolves.toEqual({ items: [], nextKey: null });
    await expect(
      listRepositoriesPage(context(emptySend), {
        limit: 1,
        startKey: { scopeOffset: 1 },
        allowedRepositoryIds: ["alpha"],
      }),
    ).resolves.toEqual({ items: [], nextKey: null });
    expect(emptySend).not.toHaveBeenCalled();

    const throttledSend = vi.fn().mockResolvedValue({
      UnprocessedKeys: { Repositories: { Keys: [{ id: "alpha" }] } },
    });
    await expect(
      listRepositoriesPage(context(throttledSend), {
        limit: 1,
        allowedRepositoryIds: ["alpha"],
      }),
    ).rejects.toThrow("repository page read was throttled");
  });

  it("treats absent response collections and scan cursors as empty", async () => {
    const send = vi.fn().mockResolvedValue({});
    await expect(
      listRepositoriesPage(context(send), { limit: 1, allowedRepositoryIds: ["missing"] }),
    ).resolves.toEqual({ items: [], nextKey: null });
    await expect(listRepositoriesPage(context(send), { limit: 1 })).resolves.toEqual({
      items: [],
      nextKey: null,
    });
  });
});
