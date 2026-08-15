import { randomUUID } from "node:crypto";

import type { SessionRecord } from "./db/types.ts";
import type {
  WebhookDestinationSelector,
  WebhookOutboxStore,
  WebhookTransport,
  WebhookTransportResult,
} from "./webhook-delivery-types.ts";
import { reconcileWebhookSession } from "./webhook-lifecycle.ts";
import { MAX_WEBHOOK_DUE_QUERY, type DurableWebhookDelivery } from "./webhook-outbox.ts";

const DEFAULT_INTERVAL_MS = 1_000;

export type WebhookWorkerOptions = {
  intervalMs?: number;
  maxDeliveriesPerTick?: number;
  dueQueryLimit?: number;
  leaseMs?: number;
  baseRetryMs?: number;
  maxRetryMs?: number;
  now?: () => string;
  leaseId?: () => string;
  owner?: string;
  onError?: (error: unknown) => void;
};

type WebhookWorkerDependencies = {
  store: WebhookOutboxStore;
  transport: WebhookTransport;
  selectDestinations: WebhookDestinationSelector;
  listSessions: () => Promise<SessionRecord[]>;
};

type ProcessResult = "idle" | "sent" | "retried" | "dead" | "lease-lost";

export async function processWebhookOutboxOnce(
  store: WebhookOutboxStore,
  transport: WebhookTransport,
  options: WebhookWorkerOptions = {},
): Promise<ProcessResult> {
  validateOptions(options);
  const now = (options.now ?? (() => new Date().toISOString()))();
  const queryLimit = options.dueQueryLimit ?? 25;
  const candidates = await dueCandidates(store, now, queryLimit);
  for (const candidate of candidates) {
    if (candidate.attemptCount >= candidate.maxAttempts) {
      if (await store.deadLetterExhaustedWebhookDelivery({ id: candidate.id, now })) return "dead";
      continue;
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
    if (!claimed) continue;
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
        retryDelay(
          claimed.attemptCount,
          options.baseRetryMs ?? 1_000,
          options.maxRetryMs ?? 60_000,
        ),
      ),
    });
    return settled === "pending" ? "retried" : settled === "dead" ? "dead" : "lease-lost";
  }
  return "idle";
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

/** Polling runtime that is inert unless every dependency is explicitly injected. */
export class WebhookWorker {
  private readonly dependencies: WebhookWorkerDependencies;
  private readonly options: WebhookWorkerOptions;
  private readonly owner: string;
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight: Promise<void> | undefined;
  private started = false;

  constructor(dependencies: WebhookWorkerDependencies, options: WebhookWorkerOptions = {}) {
    validateOptions(options);
    this.dependencies = dependencies;
    this.options = options;
    this.owner = options.owner ?? `webhook-worker-${randomUUID()}`;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.timer = setInterval(
      () => void this.tick(),
      this.options.intervalMs ?? DEFAULT_INTERVAL_MS,
    );
    this.timer.unref();
    void this.tick();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.inFlight;
    this.started = false;
  }

  async tick(): Promise<boolean> {
    if (!this.started || this.inFlight) return false;
    const tick = this.runTick();
    this.inFlight = tick;
    try {
      await tick;
      return true;
    } catch (error) {
      try {
        this.options.onError?.(error);
      } catch {
        // Observability must not poison later ticks.
      }
      return false;
    } finally {
      if (this.inFlight === tick) this.inFlight = undefined;
    }
  }

  private async runTick(): Promise<void> {
    for (const session of await this.dependencies.listSessions()) {
      await reconcileWebhookSession({
        store: this.dependencies.store,
        selectDestinations: this.dependencies.selectDestinations,
        session,
      });
    }
    const max = this.options.maxDeliveriesPerTick ?? 100;
    for (let count = 0; count < max && this.started; count += 1) {
      const result = await processWebhookOutboxOnce(
        this.dependencies.store,
        this.dependencies.transport,
        { ...this.options, owner: this.owner },
      );
      if (result === "idle") return;
    }
  }
}

function validateOptions(options: WebhookWorkerOptions): void {
  const positiveFinite = [
    options.intervalMs,
    options.leaseMs,
    options.baseRetryMs,
    options.maxRetryMs,
  ];
  if (
    positiveFinite.some((value) => value !== undefined && (!Number.isFinite(value) || value <= 0))
  ) {
    throw new RangeError("Webhook worker durations must be positive finite numbers");
  }
  const positiveIntegers = [options.maxDeliveriesPerTick, options.dueQueryLimit];
  if (
    positiveIntegers.some(
      (value) => value !== undefined && (!Number.isInteger(value) || value <= 0),
    )
  ) {
    throw new RangeError("Webhook worker limits must be positive integers");
  }
  if (options.dueQueryLimit !== undefined && options.dueQueryLimit > MAX_WEBHOOK_DUE_QUERY) {
    throw new RangeError(`Webhook worker dueQueryLimit must not exceed ${MAX_WEBHOOK_DUE_QUERY}`);
  }
}
