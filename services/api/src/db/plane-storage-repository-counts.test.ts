import { describe, expect, it, vi } from "vitest";

import {
  countSchedulesByRepository,
  countWorktreesByRepository,
} from "./plane-storage-repository-counts.ts";
import type { PlaneStorageCtx } from "./plane-storage-types.ts";

describe("repository-indexed catalog counts", () => {
  it("paginates worktree counts with an optional host filter", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Count: 1, LastEvaluatedKey: { repositoryId: "repo", id: "one" } })
      .mockResolvedValueOnce({ Count: 2 });
    const ctx = {
      doc: { send },
      tables: { worktrees: "Worktrees" },
    } as unknown as PlaneStorageCtx;

    await expect(countWorktreesByRepository(ctx, "repo", "host")).resolves.toBe(3);
    expect(send.mock.calls[0]?.[0].input).toMatchObject({
      TableName: "Worktrees",
      IndexName: "repositoryId-id",
      KeyConditionExpression: "repositoryId = :repositoryId",
      FilterExpression: "hostId = :hostId",
      ExpressionAttributeValues: { ":repositoryId": "repo", ":hostId": "host" },
      Select: "COUNT",
    });
    expect(send.mock.calls[1]?.[0].input.ExclusiveStartKey).toEqual({
      repositoryId: "repo",
      id: "one",
    });
  });

  it("counts schedules without a host filter", async () => {
    const send = vi.fn().mockResolvedValue({ Count: 4 });
    const ctx = {
      doc: { send },
      tables: { schedules: "Schedules" },
    } as unknown as PlaneStorageCtx;

    await expect(countSchedulesByRepository(ctx, "repo")).resolves.toBe(4);
    expect(send.mock.calls[0]?.[0].input.FilterExpression).toBeUndefined();
    expect(send.mock.calls[0]?.[0].input.ExpressionAttributeValues).toEqual({
      ":repositoryId": "repo",
    });
  });
});
