import { BatchGetCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { delay } = vi.hoisted(() => ({ delay: vi.fn().mockResolvedValue(undefined) }));

vi.mock("node:timers/promises", () => ({ setTimeout: delay }));

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
  beforeEach(() => {
    delay.mockClear();
  });

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
    expect(send).toHaveBeenCalledTimes(1);
    expect(delay).not.toHaveBeenCalled();
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

  it("short-circuits exhausted scopes", async () => {
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
  });

  it("retries only unprocessed keys, merges partial results, and restores the scope order", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Responses: { Repositories: [repository("bravo")] },
        UnprocessedKeys: { Repositories: { Keys: [{ id: "alpha" }, { id: "charlie" }] } },
      })
      .mockResolvedValueOnce({
        Responses: { Repositories: [repository("charlie"), repository("alpha")] },
      });

    await expect(
      listRepositoriesPage(context(send), {
        limit: 3,
        allowedRepositoryIds: ["alpha", "bravo", "charlie", "delta"],
      }),
    ).resolves.toEqual({
      items: [repository("alpha"), repository("bravo"), repository("charlie")],
      nextKey: { scopeOffset: 3 },
    });

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.map(([command]) => command.input.RequestItems)).toEqual([
      {
        Repositories: {
          Keys: [{ id: "alpha" }, { id: "bravo" }, { id: "charlie" }],
          ConsistentRead: true,
        },
      },
      {
        Repositories: {
          Keys: [{ id: "alpha" }, { id: "charlie" }],
          ConsistentRead: true,
        },
      },
    ]);
    expect(delay).toHaveBeenCalledTimes(1);
    const retryDelay = delay.mock.calls[0]?.[0];
    expect(retryDelay).toBeGreaterThanOrEqual(50);
    expect(retryDelay).toBeLessThan(100);
  });

  it("propagates an SDK failure after a partial response without another retry", async () => {
    const failure = new Error("DynamoDB unavailable");
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Responses: { Repositories: [repository("bravo")] },
        UnprocessedKeys: { Repositories: { Keys: [{ id: "alpha" }] } },
      })
      .mockRejectedValueOnce(failure);

    await expect(
      listRepositoriesPage(context(send), {
        limit: 2,
        allowedRepositoryIds: ["alpha", "bravo"],
      }),
    ).rejects.toBe(failure);

    expect(send).toHaveBeenCalledTimes(2);
    expect(delay).toHaveBeenCalledTimes(1);
  });

  it("fails after five bounded attempts with the existing throttling error", async () => {
    const throttledSend = vi.fn().mockResolvedValue({
      UnprocessedKeys: { Repositories: { Keys: [{ id: "alpha" }] } },
    });
    await expect(
      listRepositoriesPage(context(throttledSend), {
        limit: 1,
        allowedRepositoryIds: ["alpha"],
      }),
    ).rejects.toThrow("repository page read was throttled");
    expect(throttledSend).toHaveBeenCalledTimes(5);
    expect(delay).toHaveBeenCalledTimes(4);
    const retryDelays = delay.mock.calls.map(([milliseconds]) => milliseconds);
    expect(retryDelays).toHaveLength(4);
    expect(retryDelays[0]).toBeGreaterThanOrEqual(50);
    expect(retryDelays[0]).toBeLessThan(100);
    expect(retryDelays[1]).toBeGreaterThanOrEqual(100);
    expect(retryDelays[1]).toBeLessThan(200);
    expect(retryDelays[2]).toBeGreaterThanOrEqual(200);
    expect(retryDelays[2]).toBeLessThan(400);
    expect(retryDelays[3]).toBeGreaterThanOrEqual(400);
    expect(retryDelays[3]).toBeLessThan(800);
    expect(retryDelays.reduce((total, milliseconds) => total + milliseconds, 0)).toBeLessThan(1500);
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
