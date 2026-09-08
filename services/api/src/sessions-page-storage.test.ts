import { describe, expect, it, vi } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { decodeDurableSessionCursor, encodeSessionCursor } from "./control-plane-session-cursor.ts";

describe("listSessionsPageDurable storage pages", () => {
  it("returns an empty page when the requested host is outside the bound scope", async () => {
    const listSessionsPage = vi.fn(async () => ({ items: [], continuation: null }));
    const plane = new ControlPlane({ storage: { listSessionsPage } as never });
    await expect(
      plane.listSessionsPageDurable({ hostId: "host-a", scope: { hostId: "host-b" } }),
    ).resolves.toEqual({ items: [], nextCursor: null });
    expect(listSessionsPage).not.toHaveBeenCalled();
  });

  it("maps an authoritative storage page directly", async () => {
    const listSessionsPage = vi.fn(async () => ({ items: [], continuation: null }));
    const plane = new ControlPlane({ storage: { listSessionsPage } as never });
    await expect(plane.listSessionsPageDurable({ limit: 2, status: "queued" })).resolves.toEqual({
      items: [],
      nextCursor: null,
    });
    expect(listSessionsPage).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 2, status: "queued", shardCount: expect.any(Number) }),
    );
  });

  it("upgrades a v1 logical cursor to v2 while retaining its position", async () => {
    const plane = new ControlPlane({
      storage: {
        listSessionsPage: async () => ({
          items: [],
          continuation: [{ id: "status:queued:0", checkpoint: null, exhausted: false }],
        }),
      } as never,
    });
    const cursor = encodeSessionCursor(plane.state, {
      version: 1,
      sort: "latest",
      query: {
        repositoryId: null,
        status: "queued",
        hostId: null,
        concurrencyId: null,
        scheduleId: null,
        source: null,
      },
      scope: { repositoryIds: null, hostId: null },
      position: { createdAt: "2026-01-01", id: "old", priority: 0 },
    });
    const page = await plane.listSessionsPageDurable({ status: "queued", cursor });
    const upgraded = decodeDurableSessionCursor(plane.state, page.nextCursor!, {
      sort: "latest",
      query: {
        repositoryId: null,
        status: "queued",
        hostId: null,
        concurrencyId: null,
        scheduleId: null,
        source: null,
      },
      scope: { repositoryIds: null, hostId: null },
    });
    expect(upgraded).toMatchObject({ version: 2, position: { id: "old" } });
  });
});
