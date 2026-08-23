import { describe, expect, it, vi } from "vitest";

import { listRepositoriesPage } from "./plane-storage-catalog.ts";
import type { PlaneStorageCtx } from "./plane-storage-types.ts";

describe("repository storage pages", () => {
  it("fills a scoped page across hidden rows", async () => {
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
  });

  it("scans through terminal hidden pages without exposing an empty continuation page", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Items: [{ id: "hidden-1", name: "Hidden 1" }],
        LastEvaluatedKey: { id: "hidden-1" },
      })
      .mockResolvedValueOnce({ Items: [{ id: "hidden-2", name: "Hidden 2" }] });
    const ctx = {
      doc: { send },
      tables: { repositories: "Repositories" },
    } as unknown as PlaneStorageCtx;

    await expect(
      listRepositoriesPage(ctx, { limit: 1, allowedRepositoryIds: ["visible"] }),
    ).resolves.toEqual({ items: [], nextKey: null });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]?.[0].input).toMatchObject({
      ExclusiveStartKey: { id: "hidden-1" },
    });
  });

  it("passes continuation keys and handles empty scopes and terminal pages", async () => {
    const send = vi.fn().mockResolvedValue({
      Items: [{ id: "visible", name: "Visible" }],
      LastEvaluatedKey: { id: "visible" },
    });
    const ctx = {
      doc: { send },
      tables: { repositories: "Repositories" },
    } as unknown as PlaneStorageCtx;

    await expect(
      listRepositoriesPage(ctx, { limit: 1, startKey: { id: "before-hidden" } }),
    ).resolves.toEqual({
      items: [{ id: "visible", name: "Visible" }],
      nextKey: { id: "visible" },
    });
    expect(send.mock.calls[0]?.[0].input).toMatchObject({
      Limit: 1,
      ExclusiveStartKey: { id: "before-hidden" },
    });
    await expect(
      listRepositoriesPage(ctx, { limit: 1, allowedRepositoryIds: [] }),
    ).resolves.toEqual({ items: [], nextKey: null });
    expect(send).toHaveBeenCalledOnce();

    send.mockResolvedValueOnce({ Items: [] });
    await expect(listRepositoriesPage(ctx, { limit: 1 })).resolves.toEqual({
      items: [],
      nextKey: null,
    });
    expect(send).toHaveBeenCalledTimes(2);
  });
});
