import { describe, expect, it, vi } from "vitest";

import { listRepositoriesPage } from "./plane-storage-catalog.ts";
import type { PlaneStorageCtx } from "./plane-storage-types.ts";

describe("repository storage pages", () => {
  it("bounds each filtered page by evaluated rows", async () => {
    const send = vi.fn().mockResolvedValue({
      Items: [{ id: "hidden", name: "Hidden" }],
      LastEvaluatedKey: { id: "hidden" },
    });
    const ctx = {
      doc: { send },
      tables: { repositories: "Repositories" },
    } as unknown as PlaneStorageCtx;

    await expect(
      listRepositoriesPage(ctx, { limit: 1, allowedRepositoryIds: ["visible"] }),
    ).resolves.toEqual({
      items: [],
      nextKey: { id: "hidden" },
    });
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[0].input).toMatchObject({ Limit: 1, ConsistentRead: true });
    await expect(
      listRepositoriesPage(ctx, { limit: 1, startKey: { id: "before-hidden" } }),
    ).resolves.toEqual({
      items: [{ id: "hidden", name: "Hidden" }],
      nextKey: { id: "hidden" },
    });
    expect(send.mock.calls[1]?.[0].input).toMatchObject({
      Limit: 1,
      ExclusiveStartKey: { id: "before-hidden" },
    });
    await expect(
      listRepositoriesPage(ctx, { limit: 1, allowedRepositoryIds: [] }),
    ).resolves.toEqual({ items: [], nextKey: null });
    expect(send).toHaveBeenCalledTimes(2);

    send.mockResolvedValueOnce({ Items: [] });
    await expect(listRepositoriesPage(ctx, { limit: 1 })).resolves.toEqual({
      items: [],
      nextKey: null,
    });
    expect(send).toHaveBeenCalledTimes(3);
  });
});
