import { describe, expect, it, vi } from "vitest";

import { ControlPlane } from "./control-plane.ts";

describe("listSessionsPageDurable storage pages", () => {
  it("returns an empty page when the requested host is outside the bound scope", async () => {
    const listSessionsPage = vi.fn(async () => []);
    const plane = new ControlPlane({ storage: { listSessionsPage } as never });
    await expect(
      plane.listSessionsPageDurable({ hostId: "host-a", scope: { hostId: "host-b" } }),
    ).resolves.toEqual({ items: [], nextCursor: null });
    expect(listSessionsPage).not.toHaveBeenCalled();
  });

  it("asks storage for a bounded window and slices the first page in memory", async () => {
    const listSessionsPage = vi.fn(async () => []);
    const plane = new ControlPlane({ storage: { listSessionsPage } as never });
    await expect(plane.listSessionsPageDurable({ limit: 2, status: "queued" })).resolves.toEqual({
      items: [],
      nextCursor: null,
    });
    expect(listSessionsPage).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 2, status: "queued", shardCount: expect.any(Number) }),
    );
  });
});
