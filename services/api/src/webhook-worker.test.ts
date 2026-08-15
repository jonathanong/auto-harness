import { describe, expect, it, vi } from "vitest";

import type { SessionRecord } from "./db/types.ts";
import type { WebhookTransportRequest } from "./webhook-delivery-types.ts";
import type { DurableWebhookDelivery } from "./webhook-outbox.ts";
import { processWebhookOutboxOnce, retryDelay, WebhookWorker } from "./webhook-worker.ts";
import {
  webhookMemoryStore,
  webhookProcessStore,
  webhookTestDelivery,
  webhookTestDestination,
  webhookTestNow,
} from "./webhook-worker-test-helpers.ts";

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

    const lostFailure = webhookProcessStore({ failWebhookDelivery: vi.fn(async () => null) });
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
});

function terminalSession(): SessionRecord {
  return {
    id: "session-worker",
    repositoryId: "repository-1",
    prompt: "not transported",
    target: { commandId: "command-1" },
    fallbacks: [],
    targetLabels: ["Codex"],
    queueTtlSeconds: 60,
    queueExpiresAt: webhookTestNow,
    timeout: 60,
    priority: 0,
    requiredLabels: [],
    status: "completed",
    queueShard: 0,
    createdAt: webhookTestNow,
    completedAt: webhookTestNow,
  };
}

describe("WebhookWorker", () => {
  it("reconciles, drains once, and remains idempotent after restart", async () => {
    const rows = new Map<string, DurableWebhookDelivery>();
    const requests: WebhookTransportRequest[] = [];
    const store = webhookMemoryStore(rows);
    const dependencies = {
      store,
      transport: {
        async deliver(request: WebhookTransportRequest) {
          requests.push(request);
          return { ok: true } as const;
        },
      },
      selectDestinations: async () => [webhookTestDestination],
      listSessions: async () => [terminalSession()],
    };
    const options = { now: () => webhookTestNow, leaseId: () => "lease-1" };
    const first = new WebhookWorker(dependencies, options);
    first.start();
    first.start();
    await first.stop();
    expect(requests).toHaveLength(1);

    const restarted = new WebhookWorker(dependencies, { ...options, leaseId: () => "lease-2" });
    restarted.start();
    await restarted.stop();
    expect(requests).toHaveLength(1);
    expect([...rows.values()][0]).toMatchObject({ state: "delivered", attemptCount: 1 });
  });

  it("guards in-flight ticks and isolates dependency and observer failures", async () => {
    expect(() => new WebhookWorker({} as never, { intervalMs: 0 })).toThrow(RangeError);
    const onError = vi.fn(() => {
      throw new Error("observer");
    });
    const worker = new WebhookWorker(
      {
        store: webhookProcessStore(),
        transport: { deliver: vi.fn() },
        selectDestinations: vi.fn(),
        listSessions: vi.fn(async () => Promise.reject(new Error("sessions unavailable"))),
      },
      { onError },
    );
    await expect(worker.tick()).resolves.toBe(false);
    worker.start();
    await expect(worker.tick()).resolves.toBe(false);
    await worker.stop();
    expect(onError).toHaveBeenCalledOnce();
  });
});
