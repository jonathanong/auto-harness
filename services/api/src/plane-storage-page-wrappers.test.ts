import { describe, expect, it, vi } from "vitest";

import { DynamoPlaneStorageBase } from "./db/plane-storage-base.ts";
import { DynamoPlaneStorage } from "./db/plane-storage.ts";

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

  it("delegates command and provider pages through DynamoPlaneStorage", async () => {
    const send = vi.fn(async () => ({ Items: [{ id: "row-1" }] }));
    const storage = new DynamoPlaneStorage(
      { send } as never,
      { commands: "Commands", providers: "Providers" } as never,
    );
    await expect(storage.listCommandsPage({ limit: 1 })).resolves.toEqual({
      items: [{ id: "row-1" }],
      nextKey: null,
    });
    await expect(storage.listProvidersPage({ limit: 1 })).resolves.toEqual({
      items: [{ id: "row-1" }],
      nextKey: null,
    });
    expect(send).toHaveBeenCalled();
  });
});
