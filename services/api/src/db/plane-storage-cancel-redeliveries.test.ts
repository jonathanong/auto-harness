import { describe, expect, it, vi } from "vitest";

import { createDynamoTestCtx } from "./dynamo-test-helpers.ts";
import { listPendingCancelRedeliveries } from "./plane-storage-cancel-redeliveries.ts";
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
});
