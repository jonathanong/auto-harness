import { describe, expect, it, vi } from "vitest";

import { listWorktreesPage } from "./db/plane-storage-sessions.ts";
import type { PlaneStorageCtx } from "./db/plane-storage-types.ts";

describe("listWorktreesPage", () => {
  it("pages worktrees with a bounded Scan or repository Query", async () => {
    const send = vi.fn().mockResolvedValue({
      Items: [{ id: "wt-1" }],
      LastEvaluatedKey: { id: "wt-1" },
    });
    const ctx = {
      doc: { send },
      tables: { worktrees: "Worktrees" },
    } as unknown as PlaneStorageCtx;

    await expect(listWorktreesPage(ctx, { limit: 2, hostId: "host-1" })).resolves.toEqual({
      items: [{ id: "wt-1" }],
      nextKey: { id: "wt-1" },
    });
    expect(send.mock.calls[0]?.[0].input).toMatchObject({
      TableName: "Worktrees",
      Limit: 2,
      FilterExpression: "hostId = :hostId",
    });

    send.mockClear();
    send.mockResolvedValue({ Items: [{ id: "wt-2" }] });
    await expect(listWorktreesPage(ctx, { limit: 5, startKey: { id: "wt-0" } })).resolves.toEqual({
      items: [{ id: "wt-2" }],
      nextKey: null,
    });

    send.mockClear();
    send.mockResolvedValue({ Items: [{ id: "wt-3" }] });
    await expect(listWorktreesPage(ctx, { limit: 10, repositoryId: "repo-1" })).resolves.toEqual({
      items: [{ id: "wt-3" }],
      nextKey: null,
    });

    send.mockClear();
    send.mockResolvedValue({ Items: [{ id: "wt-4" }] });
    await expect(
      listWorktreesPage(ctx, { limit: 10, repositoryId: "repo-1", hostId: "host-1" }),
    ).resolves.toEqual({ items: [{ id: "wt-4" }], nextKey: null });
    expect(send.mock.calls[0]?.[0].input.IndexName).toBe("repositoryId-id");
  });
});
