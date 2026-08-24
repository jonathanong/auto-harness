import type {
  SlackSessionSnapshot,
  SlackOutboxStore,
  SlackTransport,
} from "./slack-delivery-types.ts";
import type { SlackLifecycleConfig } from "./slack-session-runtime.ts";
import { reconcileSlackSession } from "./slack-session-runtime.ts";
import { processSlackOutboxOnce } from "./slack-outbox.ts";

const DEFAULT_SLACK_WORKER_INTERVAL_MS = 1_000;

export type SlackLifecycleWorkerOptions = {
  intervalMs?: number;
  maxOperationsPerTick?: number;
  now?: () => string;
  onError?: (error: unknown) => void;
};

type SlackLifecycleWorkerDependencies = {
  store: SlackOutboxStore;
  transport: SlackTransport;
  getConfig: () => Promise<SlackLifecycleConfig | null>;
  listSessions: () => Promise<SlackSessionSnapshot[]>;
};

/** Polling runtime around the durable outbox. Local and cron inject the HTTP transport. */
export class SlackLifecycleWorker {
  private readonly dependencies: SlackLifecycleWorkerDependencies;
  private readonly intervalMs: number;
  private readonly maxOperationsPerTick: number;
  private readonly now: () => string;
  private readonly onError: ((error: unknown) => void) | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight: Promise<void> | undefined;
  private started = false;

  constructor(
    dependencies: SlackLifecycleWorkerDependencies,
    options: SlackLifecycleWorkerOptions = {},
  ) {
    this.dependencies = dependencies;
    this.intervalMs = options.intervalMs ?? DEFAULT_SLACK_WORKER_INTERVAL_MS;
    this.maxOperationsPerTick = options.maxOperationsPerTick ?? 100;
    this.now = options.now ?? (() => new Date().toISOString());
    this.onError = options.onError;
    if (!Number.isFinite(this.intervalMs) || this.intervalMs <= 0) {
      throw new RangeError("Slack worker intervalMs must be a positive finite number");
    }
    if (!Number.isInteger(this.maxOperationsPerTick) || this.maxOperationsPerTick <= 0) {
      throw new RangeError("Slack worker maxOperationsPerTick must be a positive integer");
    }
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
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
    return this.executeTick();
  }

  /** One-shot drain for cron / Lambda. Does not start the interval timer. */
  async runOnce(): Promise<boolean> {
    if (this.inFlight) return false;
    return this.executeTick();
  }

  private async runTick(): Promise<void> {
    const config = await this.dependencies.getConfig();
    if (!config?.enabled) return;
    const now = this.now();
    for (const session of await this.dependencies.listSessions()) {
      await reconcileSlackSession({ store: this.dependencies.store, config, session, now });
    }
    for (let count = 0; count < this.maxOperationsPerTick; count += 1) {
      const result = await processSlackOutboxOnce(
        this.dependencies.store,
        this.dependencies.transport,
        {
          now: this.now,
          onFailure: (event) => {
            this.report(
              new Error(`slack ${event.operation} ${event.status} ${event.id}: ${event.error}`),
            );
          },
        },
      );
      if (result === "idle") return;
    }
  }

  private async executeTick(): Promise<boolean> {
    const tick = this.runTick();
    this.inFlight = tick;
    try {
      await tick;
      return true;
    } catch (error) {
      this.report(error);
      return false;
    } finally {
      if (this.inFlight === tick) this.inFlight = undefined;
    }
  }

  private report(error: unknown): void {
    try {
      this.onError?.(error);
    } catch {
      // Observability cannot poison later worker ticks.
    }
  }
}
