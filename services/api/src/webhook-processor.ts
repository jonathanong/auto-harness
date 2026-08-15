import { randomUUID } from "node:crypto";

import type {
  WebhookOutboxStore,
  WebhookTransport,
  WebhookTransportResult,
  WebhookWorkerOptions,
} from "./webhook-delivery-types.ts";
import { MAX_WEBHOOK_DUE_QUERY, type DurableWebhookDelivery } from "./webhook-outbox.ts";

type ProcessResult = "idle" | "sent" | "retried" | "dead" | "lease-lost";

export async function processWebhookOutboxOnce(
  store: WebhookOutboxStore,
  transport: WebhookTransport,
  options: WebhookWorkerOptions = {},
): Promise<ProcessResult> {
  validateWebhookWorkerOptions(options);
  const now = (options.now ?? (() => new Date().toISOString()))();
  const candidates = await dueCandidates(store, now, options.dueQueryLimit ?? 25);
  for (const candidate of candidates) {
    const result = await processCandidate(store, transport, candidate, now, options);
    if (result) return result;
  }
  return "idle";
}

export async function processWebhookOutboxBatch(
  store: WebhookOutboxStore,
  transport: WebhookTransport,
  options: WebhookWorkerOptions,
  canContinue: () => boolean,
): Promise<void> {
  const maximum = options.maxDeliveriesPerTick ?? 100;
  const now = (options.now ?? (() => new Date().toISOString()))();
  const candidates = await dueCandidates(
    store,
    now,
    Math.min(maximum, options.dueQueryLimit ?? 25),
  );
  for (const candidate of candidates) {
    if (!canContinue()) return;
    await processCandidate(store, transport, candidate, now, options);
  }
}

async function processCandidate(
  store: WebhookOutboxStore,
  transport: WebhookTransport,
  candidate: DurableWebhookDelivery,
  now: string,
  options: WebhookWorkerOptions,
): Promise<Exclude<ProcessResult, "idle"> | null> {
  if (candidate.attemptCount >= candidate.maxAttempts) {
    return (await store.deadLetterExhaustedWebhookDelivery({ id: candidate.id, now }))
      ? "dead"
      : null;
  }
  const owner = options.owner ?? "webhook-worker";
  const leaseId = (options.leaseId ?? randomUUID)();
  const claimed = await store.claimWebhookDelivery({
    id: candidate.id,
    owner,
    leaseId,
    now,
    leaseExpiresAt: addMs(now, options.leaseMs ?? 30_000),
  });
  if (!claimed) return null;
  const fence = { id: claimed.id, owner, leaseId, now };
  let result: WebhookTransportResult;
  try {
    result = await transport.deliver({
      idempotencyKey: claimed.id,
      destination: claimed.destination,
      event: claimed.event,
      body: JSON.stringify(claimed.event),
    });
  } catch {
    result = { ok: false, failureCode: "unknown" };
  }
  if (result.ok) {
    return (await store.completeWebhookDelivery(fence)) ? "sent" : "lease-lost";
  }
  const settled = await store.failWebhookDelivery({
    ...fence,
    failureCode: result.failureCode,
    nextAttemptAt: addMs(
      now,
      retryDelay(claimed.attemptCount, options.baseRetryMs ?? 1_000, options.maxRetryMs ?? 60_000),
    ),
  });
  return settled === "pending" ? "retried" : settled === "dead" ? "dead" : "lease-lost";
}

async function dueCandidates(
  store: WebhookOutboxStore,
  now: string,
  limit: number,
): Promise<DurableWebhookDelivery[]> {
  const [pending, leased] = await Promise.all([
    store.listDueWebhookDeliveries({ state: "pending", now, limit }),
    store.listDueWebhookDeliveries({ state: "leased", now, limit }),
  ]);
  return [...pending, ...leased]
    .toSorted((a, b) => (a.dueAt ?? "").localeCompare(b.dueAt ?? "") || a.id.localeCompare(b.id))
    .slice(0, limit);
}

export function retryDelay(attempt: number, baseMs: number, maxMs: number): number {
  return Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
}

function addMs(iso: string, milliseconds: number): string {
  return new Date(Date.parse(iso) + milliseconds).toISOString();
}

export function validateWebhookWorkerOptions(options: WebhookWorkerOptions): void {
  if (options.dueQueryLimit !== undefined && options.dueQueryLimit > MAX_WEBHOOK_DUE_QUERY) {
    throw new RangeError(`Webhook worker dueQueryLimit must not exceed ${MAX_WEBHOOK_DUE_QUERY}`);
  }
  const values = [options.intervalMs, options.leaseMs, options.baseRetryMs, options.maxRetryMs];
  if (values.some((value) => value !== undefined && (!Number.isFinite(value) || value <= 0))) {
    throw new RangeError("Webhook worker durations must be positive finite numbers");
  }
  const limits = [options.maxDeliveriesPerTick, options.maxSessionsPerTick, options.dueQueryLimit];
  if (limits.some((value) => value !== undefined && (!Number.isInteger(value) || value <= 0))) {
    throw new RangeError("Webhook worker limits must be positive integers");
  }
}
