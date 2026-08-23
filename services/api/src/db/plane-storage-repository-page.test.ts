import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";

import {
  listRepositoriesPage,
  REPOSITORY_CATALOG_INDEX,
  repositoryCatalogSort,
} from "./plane-storage-catalog.ts";
import type { PlaneStorageCtx, RepositoryRecord } from "./plane-storage-types.ts";

function repository(id: string, name: string): RepositoryRecord {
  return {
    id,
    name,
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

describe("Dynamo repository keyset pages", () => {
  it("uses the ordered catalog index and the decoded name/id keyset", async () => {
    const send = vi.fn().mockResolvedValue({
      Items: [repository("bravo", "bravo"), repository("charlie", "charlie")],
      LastEvaluatedKey: { id: "charlie" },
    });

    await expect(
      listRepositoriesPage(context(send), {
        limit: 1,
        after: { name: "alpha", id: "alpha" },
      }),
    ).resolves.toEqual({ items: [repository("bravo", "bravo")], hasMore: true });

    const command = send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(QueryCommand);
    expect(command.input).toMatchObject({
      TableName: "Repositories",
      IndexName: REPOSITORY_CATALOG_INDEX,
      KeyConditionExpression: "catalogScope = :scope AND catalogSort > :after",
      ExpressionAttributeValues: {
        ":scope": "repositories",
        ":after": repositoryCatalogSort("alpha", "alpha"),
      },
      Limit: 2,
      ScanIndexForward: true,
    });
  });

  it("walks bounded index chunks until a restricted principal has a full visible page", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Items: [repository("alpha", "alpha"), repository("bravo", "bravo")],
        LastEvaluatedKey: { id: "bravo" },
      })
      .mockResolvedValueOnce({
        Items: [repository("charlie", "charlie"), repository("delta", "delta")],
      });

    await expect(
      listRepositoriesPage(context(send), {
        limit: 1,
        repositoryIds: ["charlie", "delta", "charlie"],
      }),
    ).resolves.toEqual({ items: [repository("charlie", "charlie")], hasMore: true });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(QueryCommand);
    expect(send.mock.calls[1]?.[0].input.ExclusiveStartKey).toEqual({ id: "bravo" });
  });

  it("short-circuits an empty scope and exhausts sparse visible chunks", async () => {
    const emptySend = vi.fn();
    await expect(
      listRepositoriesPage(context(emptySend), { limit: 1, repositoryIds: [] }),
    ).resolves.toEqual({ items: [], hasMore: false });
    expect(emptySend).not.toHaveBeenCalled();

    const sparseSend = vi
      .fn()
      .mockResolvedValueOnce({
        Items: [repository("alpha", "alpha"), repository("bravo", "bravo")],
        LastEvaluatedKey: { id: "bravo" },
      })
      .mockResolvedValueOnce({ Items: [repository("charlie", "charlie")] });
    await expect(
      listRepositoriesPage(context(sparseSend), {
        limit: 1,
        repositoryIds: ["not-present"],
      }),
    ).resolves.toEqual({ items: [], hasMore: false });
    expect(sparseSend).toHaveBeenCalledTimes(2);
  });
});
