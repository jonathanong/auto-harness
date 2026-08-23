import { describe, expect, it, vi } from "vitest";

import { listRepositoriesPage } from "./plane-storage-catalog.ts";
import type { PlaneStorageCtx } from "./plane-storage-types.ts";

describe("repository storage pages", () => {
  it("continues a bounded scan without rescanning filtered rows", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Items: [{ id: "hidden", name: "Hidden" }],
        LastEvaluatedKey: { id: "hidden" },
      })
      .mockResolvedValueOnce({
        Items: [{ id: "visible", name: "Visible" }],
        LastEvaluatedKey: { id: "visible" },
      });
    const ctx = {
      doc: { send },
      tables: { repositories: "Repositories" },
    } as unknown as PlaneStorageCtx;

    await expect(
      listRepositoriesPage(ctx, { limit: 1, allowedRepositoryIds: ["visible"] }),
    ).resolves.toEqual({
      items: [{ id: "visible", name: "Visible" }],
      nextKey: { id: "visible" },
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]?.[0].input).toMatchObject({ Limit: 1, ConsistentRead: true });
    expect(send.mock.calls[1]?.[0].input).toMatchObject({
      Limit: 1,
      ExclusiveStartKey: { id: "hidden" },
    });
    await expect(
      listRepositoriesPage(ctx, { limit: 1, allowedRepositoryIds: [] }),
    ).resolves.toEqual({ items: [], nextKey: null });
    expect(send).toHaveBeenCalledTimes(2);
  });
});
