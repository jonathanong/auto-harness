import { vi } from "vitest";

import type { WebhookOutboxStore } from "./webhook-delivery-types.ts";
import { createWebhookDelivery, type DurableWebhookDelivery } from "./webhook-outbox.ts";

export const webhookTestNow = "2026-08-15T12:00:00.000Z";
export const webhookTestDestination = {
  configurationId: "operations",
  configurationVersion: 2,
};

export function webhookTestDelivery(
  fields: Partial<DurableWebhookDelivery> = {},
): DurableWebhookDelivery {
  return {
    ...createWebhookDelivery({
      sessionId: "session-1",
      repositoryId: "repository-1",
      attemptId: null,
      status: "cancelled",
      occurredAt: webhookTestNow,
      destination: webhookTestDestination,
      maxAttempts: 2,
    }),
    ...fields,
  };
}

export function webhookProcessStore(fields: Partial<WebhookOutboxStore> = {}): WebhookOutboxStore {
  return {
    enqueueWebhookDelivery: vi.fn(),
    listDueWebhookDeliveries: vi.fn(async ({ state }) =>
      state === "pending" ? [webhookTestDelivery()] : [],
    ),
    claimWebhookDelivery: vi.fn(async () =>
      webhookTestDelivery({
        state: "leased",
        attemptCount: 1,
        leaseOwner: "owner",
        leaseId: "lease",
      }),
    ),
    completeWebhookDelivery: vi.fn(async () => true),
    failWebhookDelivery: vi.fn(async () => "pending"),
    deadLetterExhaustedWebhookDelivery: vi.fn(async () => false),
    ...fields,
  };
}

export function webhookMemoryStore(rows: Map<string, DurableWebhookDelivery>): WebhookOutboxStore {
  return {
    async enqueueWebhookDelivery(input) {
      const created = createWebhookDelivery(input);
      const existing = rows.get(created.id);
      if (existing) return { created: false, delivery: existing };
      rows.set(created.id, created);
      return { created: true, delivery: created };
    },
    async listDueWebhookDeliveries({ state, now, limit }) {
      return [...rows.values()]
        .filter((row) => row.state === state && (row.dueAt ?? "") <= now)
        .slice(0, limit);
    },
    async claimWebhookDelivery(input) {
      const row = rows.get(input.id);
      if (!row || row.dueAt! > input.now || row.attemptCount >= row.maxAttempts) return null;
      Object.assign(row, {
        state: "leased",
        dueAt: input.leaseExpiresAt,
        leaseExpiresAt: input.leaseExpiresAt,
        leaseOwner: input.owner,
        leaseId: input.leaseId,
        attemptCount: row.attemptCount + 1,
      });
      return structuredClone(row);
    },
    async completeWebhookDelivery(input) {
      const row = rows.get(input.id);
      if (!row || row.leaseId !== input.leaseId || row.leaseOwner !== input.owner) return false;
      Object.assign(row, { state: "delivered", deliveredAt: input.now });
      delete row.dueAt;
      return true;
    },
    async failWebhookDelivery() {
      return null;
    },
    async deadLetterExhaustedWebhookDelivery() {
      return false;
    },
  };
}
