import { describe, expect, it } from "vitest";

import { createDynamoTestCtx } from "./dynamo-test-helpers.ts";

const ctx = createDynamoTestCtx("Webhook");
const t0 = "2026-08-12T20:00:00.000Z";
const t1 = "2026-08-12T20:01:00.000Z";
const t2 = "2026-08-12T20:02:00.000Z";
const t3 = "2026-08-12T20:03:00.000Z";
const t4 = "2026-08-12T20:04:00.000Z";

function enqueueInput(suffix: string, maxAttempts = 2) {
  return {
    sessionId: `session-${suffix}`,
    repositoryId: "repository-1",
    attemptId: `attempt-${suffix}`,
    status: "completed" as const,
    occurredAt: t0,
    destination: { configurationId: "operations", configurationVersion: 1 },
    maxAttempts,
  };
}

describe("DynamoDB webhook outbox", () => {
  it("deduplicates stable events, fences workers, retries, and dead-letters the final failure", async () => {
    if (!ctx.storage) return;
    const first = await ctx.storage.enqueueWebhookDelivery(enqueueInput("retry"));
    expect(first.created).toBe(true);
    expect((await ctx.storage.enqueueWebhookDelivery(enqueueInput("retry"))).created).toBe(false);
    expect(await ctx.storage.getWebhookDelivery("missing")).toBeNull();
    expect(
      await ctx.storage.listDueWebhookDeliveries({ state: "pending", now: t0, limit: 1 }),
    ).toEqual([first.delivery]);

    const lease1 = { id: first.delivery.id, owner: "worker-1", leaseId: "lease-1" };
    const claimed1 = await ctx.storage.claimWebhookDelivery({
      ...lease1,
      now: t0,
      leaseExpiresAt: t1,
    });
    expect(claimed1).toMatchObject({
      id: first.delivery.id,
      state: "leased",
      attemptCount: 1,
      leaseOwner: "worker-1",
      leaseId: "lease-1",
    });
    expect(
      await ctx.storage.claimWebhookDelivery({
        id: first.delivery.id,
        owner: "worker-2",
        leaseId: "lease-race",
        now: t0,
        leaseExpiresAt: t1,
      }),
    ).toBeNull();
    expect(
      await ctx.storage.failWebhookDelivery({
        ...lease1,
        leaseId: "stale-lease",
        now: t0,
        nextAttemptAt: t2,
        failureCode: "transient-failure",
      }),
    ).toBeNull();
    expect(
      await ctx.storage.failWebhookDelivery({
        ...lease1,
        now: t0,
        nextAttemptAt: t2,
        failureCode: "transient-failure",
      }),
    ).toBe("pending");
    expect(
      await ctx.storage.claimWebhookDelivery({
        id: first.delivery.id,
        owner: "worker-2",
        leaseId: "too-early",
        now: t1,
        leaseExpiresAt: t2,
      }),
    ).toBeNull();

    const lease2 = { id: first.delivery.id, owner: "worker-2", leaseId: "lease-2" };
    expect(
      await ctx.storage.claimWebhookDelivery({ ...lease2, now: t2, leaseExpiresAt: t3 }),
    ).toMatchObject({
      id: first.delivery.id,
      state: "leased",
      attemptCount: 2,
      leaseOwner: "worker-2",
      leaseId: "lease-2",
    });
    expect(await ctx.storage.completeWebhookDelivery({ ...lease1, now: t2 })).toBe(false);
    expect(
      await ctx.storage.failWebhookDelivery({
        ...lease2,
        now: t2,
        nextAttemptAt: t4,
        failureCode: "delivery-rejected",
      }),
    ).toBe("dead");
    expect(await ctx.storage.getWebhookDelivery(first.delivery.id)).toMatchObject({
      state: "dead",
      attemptCount: 2,
      deadLetteredAt: t2,
      lastFailureCode: "delivery-rejected",
    });
    expect(
      await ctx.storage.listDueWebhookDeliveries({ state: "pending", now: t4, limit: 10 }),
    ).toEqual([]);
  });

  it("recovers expired leases with an exact new fence and dead-letters abandoned exhaustion", async () => {
    if (!ctx.storage) return;
    const recoverable = await ctx.storage.enqueueWebhookDelivery(enqueueInput("recover", 2));
    await ctx.storage.claimWebhookDelivery({
      id: recoverable.delivery.id,
      owner: "old-worker",
      leaseId: "old-lease",
      now: t0,
      leaseExpiresAt: t1,
    });
    expect(
      await ctx.storage.completeWebhookDelivery({
        id: recoverable.delivery.id,
        owner: "old-worker",
        leaseId: "old-lease",
        now: t1,
      }),
    ).toBe(false);
    expect(
      (await ctx.storage.listDueWebhookDeliveries({ state: "leased", now: t1, limit: 10 })).filter(
        ({ id }) => id === recoverable.delivery.id,
      ),
    ).toHaveLength(1);
    const reclaimed = await ctx.storage.claimWebhookDelivery({
      id: recoverable.delivery.id,
      owner: "new-worker",
      leaseId: "new-lease",
      now: t1,
      leaseExpiresAt: t2,
    });
    expect(reclaimed).toMatchObject({ attemptCount: 2, leaseId: "new-lease" });
    expect(
      await ctx.storage.deadLetterExhaustedWebhookDelivery({
        id: recoverable.delivery.id,
        now: t1,
      }),
    ).toBe(false);
    expect(
      await ctx.storage.deadLetterExhaustedWebhookDelivery({
        id: recoverable.delivery.id,
        now: t2,
      }),
    ).toBe(true);
    expect(
      await ctx.storage.deadLetterExhaustedWebhookDelivery({
        id: recoverable.delivery.id,
        now: t2,
      }),
    ).toBe(false);
  });

  it("completes only a live exact lease and validates unsafe queue inputs", async () => {
    if (!ctx.storage) return;
    const completed = await ctx.storage.enqueueWebhookDelivery(enqueueInput("complete", 1));
    const fence = { id: completed.delivery.id, owner: "worker", leaseId: "lease", now: t0 };
    await ctx.storage.claimWebhookDelivery({ ...fence, leaseExpiresAt: t1 });
    expect(await ctx.storage.completeWebhookDelivery(fence)).toBe(true);
    expect(await ctx.storage.completeWebhookDelivery(fence)).toBe(false);
    expect(await ctx.storage.getWebhookDelivery(completed.delivery.id)).toMatchObject({
      state: "delivered",
      deliveredAt: t0,
    });

    await expect(
      ctx.storage.listDueWebhookDeliveries({ state: "pending", now: t0, limit: 0 }),
    ).rejects.toThrow("limit");
    await expect(
      ctx.storage.claimWebhookDelivery({
        id: completed.delivery.id,
        owner: "worker",
        leaseId: "lease",
        now: t1,
        leaseExpiresAt: t1,
      }),
    ).rejects.toThrow("after now");
    await expect(
      ctx.storage.failWebhookDelivery({
        id: completed.delivery.id,
        owner: "worker",
        leaseId: "lease",
        now: t1,
        nextAttemptAt: t1,
        failureCode: "unknown",
      }),
    ).rejects.toThrow("after now");
  });
});
