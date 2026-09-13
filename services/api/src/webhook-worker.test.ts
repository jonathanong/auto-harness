/* eslint-disable max-lines -- processor timing and lease outcomes share one focused fixture. */
import { describe, expect, it, vi } from "vitest";

import type { WebhookTransportRequest } from "./webhook-delivery-types.ts";
import { processWebhookOutboxBatch } from "./webhook-processor.ts";
import { processWebhookOutboxOnce, retryDelay } from "./webhook-worker.ts";
import {
  webhookProcessStore,
  webhookTestDelivery,
  webhookTestDestination,
  webhookTestNow,
} from "../test-helpers/webhook-worker-test-helpers.ts";

describe("webhook outbox processor", () => {
  it("delivers exact secret-safe bytes and completes a live lease", async () => {
    const store = webhookProcessStore();
    const requests: WebhookTransportRequest[] = [];
    await expect(
      processWebhookOutboxOnce(
        store,
        {
          async deliver(request) {
            requests.push(request);
            return { ok: true };
          },
        },
        { now: () => webhookTestNow, owner: "owner", leaseId: () => "lease" },
      ),
    ).resolves.toBe("sent");
    expect(requests[0]).toMatchObject({
      idempotencyKey: webhookTestDelivery().id,
      destination: webhookTestDestination,
      event: webhookTestDelivery().event,
    });
    expect(requests[0]!.body).toBe(JSON.stringify(webhookTestDelivery().event));
    expect(requests[0]!.body).not.toMatch(/prompt|secret|url/i);
  });

  it("classifies bounded failures, retries with backoff, and dead-letters the final attempt", async () => {
    const reschedule = vi.fn(async () => "pending" as const);
    const store = webhookProcessStore({ failWebhookDelivery: reschedule });
    await expect(
      processWebhookOutboxOnce(
        store,
        { deliver: async () => ({ ok: false, failureCode: "configuration-unavailable" }) },
        { now: () => webhookTestNow, baseRetryMs: 2_000, maxRetryMs: 10_000 },
      ),
    ).resolves.toBe("retried");
    expect(reschedule).toHaveBeenCalledWith(
      expect.objectContaining({
        failureCode: "configuration-unavailable",
        nextAttemptAt: "2026-08-15T12:00:02.000Z",
      }),
    );

    const final = webhookProcessStore({
      claimWebhookDelivery: vi.fn(async () =>
        webhookTestDelivery({ state: "leased", attemptCount: 2 }),
      ),
      failWebhookDelivery: vi.fn(async () => "dead"),
    });
    await expect(
      processWebhookOutboxOnce(
        final,
        { deliver: async () => Promise.reject(new Error("boom")) },
        {
          now: () => webhookTestNow,
        },
      ),
    ).resolves.toBe("dead");
    expect(final.failWebhookDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ failureCode: "unknown" }),
    );
    expect(retryDelay(1, 1_000, 5_000)).toBe(1_000);
    expect(retryDelay(5, 1_000, 5_000)).toBe(5_000);
  });

  it("recovers expired leases, fences ambiguous success, and skips lost candidates", async () => {
    const expired = webhookTestDelivery({
      state: "leased",
      dueAt: webhookTestNow,
      attemptCount: 1,
      leaseOwner: "old",
      leaseId: "old",
    });
    const store = webhookProcessStore({
      listDueWebhookDeliveries: vi.fn(async ({ state }) => (state === "leased" ? [expired] : [])),
      completeWebhookDelivery: vi.fn(async () => false),
    });
    await expect(
      processWebhookOutboxOnce(
        store,
        { deliver: async () => ({ ok: true }) },
        { now: () => webhookTestNow },
      ),
    ).resolves.toBe("lease-lost");

    const terminal = vi.fn(async () => true);
    const permanent = webhookProcessStore({ deadLetterWebhookDelivery: terminal });
    await expect(
      processWebhookOutboxOnce(
        permanent,
        { deliver: async () => ({ ok: false, failureCode: "delivery-rejected" }) },
        { now: () => webhookTestNow },
      ),
    ).resolves.toBe("dead");
    expect(terminal).toHaveBeenCalledWith(
      expect.objectContaining({ failureCode: "delivery-rejected" }),
    );
    expect(permanent.failWebhookDelivery).not.toHaveBeenCalled();

    const lostFailure = webhookProcessStore({
      deadLetterWebhookDelivery: vi.fn(async () => false),
    });
    await expect(
      processWebhookOutboxOnce(
        lostFailure,
        { deliver: async () => ({ ok: false, failureCode: "delivery-rejected" }) },
        { now: () => webhookTestNow },
      ),
    ).resolves.toBe("lease-lost");

    const skipped = webhookProcessStore({ claimWebhookDelivery: vi.fn(async () => null) });
    await expect(
      processWebhookOutboxOnce(skipped, { deliver: vi.fn() }, { now: () => webhookTestNow }),
    ).resolves.toBe("idle");
  });

  it("uses settlement time when permanently rejecting a slow delivery", async () => {
    const terminal = vi.fn(async () => true);
    const store = webhookProcessStore({ deadLetterWebhookDelivery: terminal });
    const nowValues = [webhookTestNow, "2026-08-15T12:00:10.000Z"];
    await expect(
      processWebhookOutboxOnce(
        store,
        { deliver: async () => ({ ok: false, failureCode: "delivery-rejected" }) },
        { now: () => nowValues.shift()! },
      ),
    ).resolves.toBe("dead");
    expect(terminal).toHaveBeenCalledWith(
      expect.objectContaining({ now: "2026-08-15T12:00:10.000Z" }),
    );
  });

  it("uses settlement time when completing a slow success", async () => {
    const complete = vi.fn(async () => true);
    const store = webhookProcessStore({ completeWebhookDelivery: complete });
    const nowValues = [webhookTestNow, "2026-08-15T12:00:40.000Z"];
    await expect(
      processWebhookOutboxOnce(
        store,
        { deliver: async () => ({ ok: true }) },
        { now: () => nowValues.shift()! },
      ),
    ).resolves.toBe("sent");
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({ now: "2026-08-15T12:00:40.000Z" }),
    );
  });

  it("uses settlement time when retrying a slow transient failure", async () => {
    const reschedule = vi.fn(async () => "pending" as const);
    const store = webhookProcessStore({ failWebhookDelivery: reschedule });
    const nowValues = [webhookTestNow, "2026-08-15T12:00:40.000Z"];
    await expect(
      processWebhookOutboxOnce(
        store,
        { deliver: async () => ({ ok: false, failureCode: "transient-failure" }) },
        { now: () => nowValues.shift()!, baseRetryMs: 2_000, maxRetryMs: 10_000 },
      ),
    ).resolves.toBe("retried");
    expect(reschedule).toHaveBeenCalledWith(
      expect.objectContaining({
        now: "2026-08-15T12:00:40.000Z",
        nextAttemptAt: "2026-08-15T12:00:42.000Z",
      }),
    );
  });

  it("does not complete or retry when settlement time is after the lease", async () => {
    const complete = vi.fn(async () => false);
    const success = webhookProcessStore({ completeWebhookDelivery: complete });
    const nowValues = [webhookTestNow, "2026-08-15T12:00:40.000Z"];
    await expect(
      processWebhookOutboxOnce(
        success,
        { deliver: async () => ({ ok: true }) },
        { now: () => nowValues.shift()! },
      ),
    ).resolves.toBe("lease-lost");
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({ now: "2026-08-15T12:00:40.000Z" }),
    );

    const reschedule = vi.fn(async () => null);
    const retry = webhookProcessStore({ failWebhookDelivery: reschedule });
    const retryNow = [webhookTestNow, "2026-08-15T12:00:40.000Z"];
    await expect(
      processWebhookOutboxOnce(
        retry,
        { deliver: async () => ({ ok: false, failureCode: "transient-failure" }) },
        { now: () => retryNow.shift()! },
      ),
    ).resolves.toBe("lease-lost");
    expect(reschedule).toHaveBeenCalledWith(
      expect.objectContaining({ now: "2026-08-15T12:00:40.000Z" }),
    );
  });

  it("dead-letters exhausted due rows before claiming and validates bounds", async () => {
    const exhausted = webhookTestDelivery({ attemptCount: 2 });
    const store = webhookProcessStore({
      listDueWebhookDeliveries: vi.fn(async ({ state }) =>
        state === "pending" ? [exhausted] : [],
      ),
      deadLetterExhaustedWebhookDelivery: vi.fn(async () => true),
    });
    await expect(
      processWebhookOutboxOnce(store, { deliver: vi.fn() }, { now: () => webhookTestNow }),
    ).resolves.toBe("dead");
    expect(store.claimWebhookDelivery).not.toHaveBeenCalled();

    for (const options of [{ leaseMs: 0 }, { maxDeliveriesPerTick: 0 }, { dueQueryLimit: 101 }]) {
      await expect(processWebhookOutboxOnce(store, { deliver: vi.fn() }, options)).rejects.toThrow(
        RangeError,
      );
    }
  });

  it("continues after lost exhausted rows, orders fallback due keys, and honors batch shutdown", async () => {
    const first = webhookTestDelivery({ id: "b", dueAt: undefined, attemptCount: 2 });
    const second = webhookTestDelivery({ id: "a", dueAt: undefined, attemptCount: 2 });
    const store = webhookProcessStore({
      listDueWebhookDeliveries: vi.fn(async ({ state }) =>
        state === "pending" ? [first, second] : [],
      ),
      deadLetterExhaustedWebhookDelivery: vi.fn(async () => false),
    });
    await expect(processWebhookOutboxOnce(store, { deliver: vi.fn() })).resolves.toBe("idle");
    expect(store.deadLetterExhaustedWebhookDelivery).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ id: "a" }),
    );

    await processWebhookOutboxBatch(store, { deliver: vi.fn() }, {}, () => false);
    expect(store.deadLetterExhaustedWebhookDelivery).toHaveBeenCalledTimes(2);
  });

  it("uses the default clock when processing a live batch candidate", async () => {
    const store = webhookProcessStore();
    await expect(
      processWebhookOutboxBatch(store, { deliver: async () => ({ ok: true }) }, {}, () => true),
    ).resolves.toBeUndefined();
    expect(store.claimWebhookDelivery).toHaveBeenCalledOnce();
  });

  it("claims sequential batch candidates using their current time", async () => {
    const first = webhookTestDelivery({ id: "first", dueAt: webhookTestNow });
    const second = webhookTestDelivery({ id: "second", dueAt: webhookTestNow });
    const claimed: Array<{ id: string; now: string; leaseExpiresAt: string }> = [];
    const store = webhookProcessStore({
      listDueWebhookDeliveries: vi.fn(async ({ state }) =>
        state === "pending" ? [first, second] : [],
      ),
      claimWebhookDelivery: vi.fn(async (input) => {
        claimed.push(input);
        return webhookTestDelivery({ id: input.id, attemptCount: 1, state: "leased" });
      }),
    });
    const nowValues = [
      webhookTestNow,
      "2026-08-15T12:00:01.000Z",
      "2026-08-15T12:00:01.500Z",
      "2026-08-15T12:00:10.000Z",
      "2026-08-15T12:00:10.500Z",
    ];
    await processWebhookOutboxBatch(
      store,
      { deliver: async () => ({ ok: true }) },
      { now: () => nowValues.shift()!, leaseMs: 30_000 },
      () => true,
    );
    expect(claimed).toMatchObject([
      { id: "first", now: "2026-08-15T12:00:01.000Z", leaseExpiresAt: "2026-08-15T12:00:31.000Z" },
      { id: "second", now: "2026-08-15T12:00:10.000Z", leaseExpiresAt: "2026-08-15T12:00:40.000Z" },
    ]);
  });

  it("reports a lease loss when retry settlement no longer owns the delivery", async () => {
    const store = webhookProcessStore({ failWebhookDelivery: vi.fn(async () => null) });
    await expect(
      processWebhookOutboxOnce(
        store,
        { deliver: async () => ({ ok: false, failureCode: "transient-failure" }) },
        { now: () => webhookTestNow },
      ),
    ).resolves.toBe("lease-lost");
  });
});
