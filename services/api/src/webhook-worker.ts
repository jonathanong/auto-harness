import { randomUUID } from "node:crypto";

import type { SessionRecord } from "./db/types.ts";
import type {
  WebhookDestinationSelector,
  WebhookOutboxStore,
  WebhookTransport,
  WebhookWorkerOptions,
} from "./webhook-delivery-types.ts";
import { reconcileWebhookSession } from "./webhook-lifecycle.ts";
import { processWebhookOutboxBatch, validateWebhookWorkerOptions } from "./webhook-processor.ts";

export { processWebhookOutboxOnce, retryDelay } from "./webhook-processor.ts";
export type { WebhookWorkerOptions } from "./webhook-delivery-types.ts";

const DEFAULT_INTERVAL_MS = 1_000;
const DEFAULT_SESSION_LIMIT = 100;

type WebhookWorkerDependencies = {
  store: WebhookOutboxStore;
  transport: WebhookTransport;
  selectDestinations: WebhookDestinationSelector;
  listSessions: () => Promise<SessionRecord[]>;
};

/** Polling runtime that is inert unless every dependency is explicitly injected. */
export class WebhookWorker {
  private readonly dependencies: WebhookWorkerDependencies;
  private readonly options: WebhookWorkerOptions;
  private readonly owner: string;
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight: Promise<void> | undefined;
  private started = false;
  private nextSessionIndex = 0;
  private readonly reconciledSessions = new Map<string, string>();

  constructor(dependencies: WebhookWorkerDependencies, options: WebhookWorkerOptions = {}) {
    validateWebhookWorkerOptions(options);
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
    this.started = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.inFlight;
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
    const sessions = await this.dependencies.listSessions();
    const sessionLimit = this.options.maxSessionsPerTick ?? DEFAULT_SESSION_LIMIT;
    const start = sessions.length === 0 ? 0 : this.nextSessionIndex % sessions.length;
    const sessionCount = Math.min(sessionLimit, sessions.length);
    for (let offset = 0; offset < sessionCount && this.started; offset += 1) {
      const session = sessions[(start + offset) % sessions.length]!;
      const fingerprint = `${session.status}\0${session.attemptId ?? ""}\0${session.completedAt ?? ""}`;
      if (this.reconciledSessions.get(session.id) === fingerprint) continue;
      await reconcileWebhookSession({
        store: this.dependencies.store,
        selectDestinations: this.dependencies.selectDestinations,
        session,
      });
      this.reconciledSessions.set(session.id, fingerprint);
    }
    this.nextSessionIndex = sessions.length === 0 ? 0 : (start + sessionCount) % sessions.length;

    await processWebhookOutboxBatch(
      this.dependencies.store,
      this.dependencies.transport,
      {
        ...this.options,
        owner: this.owner,
      },
      () => this.started,
    );
  }
}
