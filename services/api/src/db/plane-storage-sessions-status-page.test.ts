import { describe, expect, it, vi } from "vitest";

import { listSessionsByStatusPage } from "./plane-storage-sessions-status-page.ts";
import type { PlaneStorageCtx } from "./plane-storage-types.ts";

describe("bounded session status pages", () => {
  it("limits the event-driven queued page without paginating either index", async () => {
    const send = vi.fn().mockResolvedValue({
      Items: [
        {
          id: "session-1",
          status: "queued",
          queueShard: 0,
          queueOrder: "ordered",
          createdAt: "t1",
          priority: 0,
        },
      ],
    });
    const ctx = {
      doc: { send },
      tables: { sessions: "Sessions" },
    } as unknown as PlaneStorageCtx;

    await expect(listSessionsByStatusPage(ctx, "queued", 0, 3)).resolves.toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(2);
    for (const [command] of send.mock.calls) {
      expect(command.input.Limit).toBe(3);
      expect(command.input.ExclusiveStartKey).toBeUndefined();
    }
  });

  it("handles empty non-queued pages", async () => {
    const ctx = {
      doc: { send: vi.fn().mockResolvedValue({}) },
      tables: { sessions: "Sessions" },
    } as unknown as PlaneStorageCtx;

    await expect(listSessionsByStatusPage(ctx, "running", 0, 1)).resolves.toEqual([]);
  });

  it("falls back from an unavailable queue index and propagates other query failures", async () => {
    const unavailable = Object.assign(new Error("index is backfilling"), {
      name: "ValidationException",
    });
    const fallback = {
      doc: {
        send: vi.fn().mockRejectedValueOnce(unavailable).mockResolvedValueOnce({ Items: [] }),
      },
      tables: { sessions: "Sessions" },
    } as unknown as PlaneStorageCtx;
    await expect(listSessionsByStatusPage(fallback, "queued", 0, 1)).resolves.toEqual([]);

    const failure = new Error("network failure");
    const failing = {
      doc: { send: vi.fn().mockRejectedValue(failure) },
      tables: { sessions: "Sessions" },
    } as unknown as PlaneStorageCtx;
    await expect(listSessionsByStatusPage(failing, "queued", 0, 1)).rejects.toBe(failure);
  });
});
