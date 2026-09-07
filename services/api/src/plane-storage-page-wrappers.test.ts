import { describe, expect, it, vi } from "vitest";

import { DynamoPlaneStorageBase } from "./db/plane-storage-base.ts";

describe("DynamoPlaneStorageBase page wrappers", () => {
  it("delegates session and worktree pages to the storage helpers", async () => {
    const send = vi.fn(async () => ({ Items: [] }));
    const storage = new DynamoPlaneStorageBase(
      { send } as never,
      {
        sessions: "Sessions",
        worktrees: "Worktrees",
      } as never,
    );
    await expect(
      storage.listSessionsPage({
        limit: 1,
        sort: "latest",
        shardCount: 1,
        status: "queued",
        repositoryId: null,
        repositoryIds: null,
        hostId: null,
        source: null,
        concurrencyId: null,
        scheduleId: null,
      }),
    ).resolves.toEqual([]);
    await expect(storage.listWorktreesPage({ limit: 1 })).resolves.toEqual({
      items: [],
      nextKey: null,
    });
    expect(send).toHaveBeenCalled();
  });
});
