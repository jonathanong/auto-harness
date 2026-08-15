import { describe, expect, it, vi } from "vitest";

import type { SessionRecord } from "./db/types.ts";
import type { WebhookTransportRequest } from "./webhook-delivery-types.ts";
import type { DurableWebhookDelivery } from "./webhook-outbox.ts";
import { WebhookWorker } from "./webhook-worker.ts";
import {
  webhookMemoryStore,
  webhookProcessStore,
  webhookTestDelivery,
  webhookTestDestination,
  webhookTestNow,
} from "./webhook-worker-test-helpers.ts";

function terminalSession(id = "session-worker"): SessionRecord {
  return {
    id,
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
    const listDue = vi.spyOn(store, "listDueWebhookDeliveries");
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
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    await first.stop();
    expect(listDue).toHaveBeenCalledTimes(2);

    const restarted = new WebhookWorker(dependencies, { ...options, leaseId: () => "lease-2" });
    restarted.start();
    await vi.waitFor(() => expect(listDue).toHaveBeenCalledTimes(4));
    await restarted.stop();
    expect(requests).toHaveLength(1);
    expect([...rows.values()][0]).toMatchObject({ state: "delivered", attemptCount: 1 });
  });

  it("rotates through a bounded session batch without reconciling unchanged rows twice", async () => {
    const rows = new Map<string, DurableWebhookDelivery>();
    const selectDestinations = vi.fn(async () => [webhookTestDestination]);
    const worker = new WebhookWorker(
      {
        store: webhookMemoryStore(rows),
        transport: { deliver: async () => ({ ok: true }) },
        selectDestinations,
        listSessions: async () => [terminalSession("one"), terminalSession("two")],
      },
      { maxSessionsPerTick: 1, now: () => webhookTestNow },
    );
    worker.start();
    await vi.waitFor(() =>
      expect([...rows.values()]).toEqual([expect.objectContaining({ state: "delivered" })]),
    );
    await worker.tick();
    await vi.waitFor(() => expect(rows.size).toBe(2));
    expect(selectDestinations).toHaveBeenCalledTimes(2);
    await worker.tick();
    expect(selectDestinations).toHaveBeenCalledTimes(2);
    await worker.stop();
  });

  it("stops before starting another delivery and isolates observer failures", async () => {
    expect(() => new WebhookWorker({} as never, { intervalMs: 0 })).toThrow(RangeError);
    expect(() => new WebhookWorker({} as never, { maxSessionsPerTick: 0 })).toThrow(RangeError);
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

  it("drains existing deliveries when historical destination resolution fails", async () => {
    const row = webhookTestDelivery();
    const rows = new Map([[row.id, row]]);
    const onError = vi.fn();
    const deliver = vi.fn(async () => ({ ok: true }) as const);
    const worker = new WebhookWorker(
      {
        store: webhookMemoryStore(rows),
        transport: { deliver },
        selectDestinations: async () => Promise.reject(new Error("configuration unavailable")),
        listSessions: async () => [terminalSession()],
      },
      { now: () => webhookTestNow, onError },
    );
    worker.start();
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());
    await worker.stop();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "configuration unavailable" }),
    );
    expect([...rows.values()][0]).toMatchObject({ state: "delivered" });
  });
});
