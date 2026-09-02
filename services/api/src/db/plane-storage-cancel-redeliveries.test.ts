import { describe, expect, it, vi } from "vitest";

import { createDynamoTestCtx } from "./dynamo-test-helpers.ts";
import {
  claimCancelRedeliveryAttempt,
  deferPendingCancelRedelivery,
  listPendingCancelRedeliveries,
} from "./plane-storage-cancel-redeliveries.ts";
import type { PlaneStorageCtx } from "./plane-storage-types.ts";

const ctx = createDynamoTestCtx("CancelRedeliver");
const t0 = "2026-08-12T20:00:00.000Z";
const t1 = "2026-08-12T20:01:00.000Z";

describe("cancel redelivery outbox query response handling", () => {
  it("returns an empty list when the query response omits Items", async () => {
    const mockCtx = {
      doc: { send: vi.fn().mockResolvedValue({}) },
      tables: { sessionCancelRedeliveries: "SessionCancelRedeliveries" },
    } as unknown as PlaneStorageCtx;

    await expect(listPendingCancelRedeliveries(mockCtx, 10)).resolves.toEqual([]);
  });

  it("rethrows a real error from deferPendingCancelRedelivery", async () => {
    const mockCtx = {
      doc: { send: vi.fn().mockRejectedValue(new Error("table unavailable")) },
      tables: { sessionCancelRedeliveries: "SessionCancelRedeliveries" },
    } as unknown as PlaneStorageCtx;

    await expect(deferPendingCancelRedelivery(mockCtx, "session-a", t0)).rejects.toThrow(
      "table unavailable",
    );
  });

  it("rethrows a real error from claimCancelRedeliveryAttempt", async () => {
    const mockCtx = {
      doc: { send: vi.fn().mockRejectedValue(new Error("table unavailable")) },
      tables: { sessionCancelRedeliveries: "SessionCancelRedeliveries" },
    } as unknown as PlaneStorageCtx;

    await expect(claimCancelRedeliveryAttempt(mockCtx, "session-a", t0, 3)).rejects.toThrow(
      "table unavailable",
    );
  });
});

describe("DynamoDB cancel redelivery outbox", () => {
  it("records, lists by pending status, tracks attempts, and clears on ack", async () => {
    if (!ctx.storage) return;
    await ctx.storage.recordPendingCancelRedelivery({
      sessionId: "session-a",
      hostId: "host-1",
      attemptId: "attempt-1",
      now: t0,
    });
    expect(await ctx.storage.listPendingCancelRedeliveries(10)).toEqual([
      {
        sessionId: "session-a",
        hostId: "host-1",
        attemptId: "attempt-1",
        status: "pending",
        attempts: 0,
        createdAt: t0,
        queuedAt: t0,
        updatedAt: t0,
      },
    ]);

    await expect(ctx.storage.claimCancelRedeliveryAttempt("session-a", t1, 3)).resolves.toBe(true);
    expect(await ctx.storage.listPendingCancelRedeliveries(10)).toEqual([
      expect.objectContaining({ sessionId: "session-a", attempts: 1, updatedAt: t1 }),
    ]);

    await ctx.storage.clearPendingCancelRedelivery("session-a");
    expect(await ctx.storage.listPendingCancelRedeliveries(10)).toEqual([]);
  });

  it("fails the claim once the attempt limit is reached, leaving the record unchanged", async () => {
    if (!ctx.storage) return;
    await ctx.storage.recordPendingCancelRedelivery({
      sessionId: "session-limit",
      hostId: "host-1",
      attemptId: "attempt-1",
      now: t0,
    });

    await expect(ctx.storage.claimCancelRedeliveryAttempt("session-limit", t1, 1)).resolves.toBe(
      true,
    );
    await expect(ctx.storage.claimCancelRedeliveryAttempt("session-limit", t1, 1)).resolves.toBe(
      false,
    );
    expect(await ctx.storage.listPendingCancelRedeliveries(10)).toEqual([
      expect.objectContaining({ sessionId: "session-limit", attempts: 1, updatedAt: t1 }),
    ]);

    await ctx.storage.clearPendingCancelRedelivery("session-limit");
  });

  it("lists only up to the requested limit, oldest first", async () => {
    if (!ctx.storage) return;
    await ctx.storage.recordPendingCancelRedelivery({
      sessionId: "session-older",
      hostId: "host-1",
      attemptId: "attempt-older",
      now: t0,
    });
    await ctx.storage.recordPendingCancelRedelivery({
      sessionId: "session-newer",
      hostId: "host-1",
      attemptId: "attempt-newer",
      now: t1,
    });
    const [first] = await ctx.storage.listPendingCancelRedeliveries(1);
    expect(first).toMatchObject({ sessionId: "session-older" });

    await ctx.storage.clearPendingCancelRedelivery("session-older");
    await ctx.storage.clearPendingCancelRedelivery("session-newer");
  });

  it("deferring a candidate moves it behind an unrelated newer one, unblocking it", async () => {
    if (!ctx.storage) return;
    // Two disconnected-host rows created before a third, connected-host row: without
    // deferral, a limit-2 page returns only the stuck pair forever and the connected-host
    // row is never seen.
    await ctx.storage.recordPendingCancelRedelivery({
      sessionId: "session-stuck-1",
      hostId: "host-down",
      attemptId: "attempt-stuck-1",
      now: t0,
    });
    await ctx.storage.recordPendingCancelRedelivery({
      sessionId: "session-stuck-2",
      hostId: "host-down",
      attemptId: "attempt-stuck-2",
      now: t0,
    });
    const t2 = "2026-08-12T20:02:00.000Z";
    await ctx.storage.recordPendingCancelRedelivery({
      sessionId: "session-connected",
      hostId: "host-up",
      attemptId: "attempt-connected",
      now: t2,
    });

    const firstPage = await ctx.storage.listPendingCancelRedeliveries(2);
    expect(firstPage.map((r) => r.sessionId)).toEqual(["session-stuck-1", "session-stuck-2"]);

    // Distinct defer timestamps per candidate, matching the real loop (`state.now()` is called
    // once per candidate in `redeliverPendingCancels`) — deferring both to the same instant would
    // leave their relative order on the `status-queuedAt` GSI unspecified.
    const t3 = "2026-08-12T20:03:00.000Z";
    const t4 = "2026-08-12T20:04:00.000Z";
    await ctx.storage.deferPendingCancelRedelivery("session-stuck-1", t3);
    await ctx.storage.deferPendingCancelRedelivery("session-stuck-2", t4);

    const secondPage = await ctx.storage.listPendingCancelRedeliveries(2);
    expect(secondPage.map((r) => r.sessionId)).toEqual(["session-connected", "session-stuck-1"]);

    await ctx.storage.clearPendingCancelRedelivery("session-stuck-1");
    await ctx.storage.clearPendingCancelRedelivery("session-stuck-2");
    await ctx.storage.clearPendingCancelRedelivery("session-connected");
  });

  it("no-ops deferring a candidate that was already cleared", async () => {
    if (!ctx.storage) return;
    await expect(
      ctx.storage.deferPendingCancelRedelivery("session-already-cleared", t1),
    ).resolves.toBeUndefined();
  });
});
