import type { ControlPlane } from "./control-plane.ts";

/** EventBridge-equivalent cadence for the local control plane. */
export const DEFAULT_LOCAL_SCHEDULER_INTERVAL_MS = 60_000;

function reportSchedulerError(error: unknown): void {
  console.error("local scheduler operation failed", error);
}

type SchedulerPlane = Pick<
  ControlPlane,
  | "evaluateCronDurable"
  | "enforceAckDeadlinesDurable"
  | "enforceRunningTimeoutsDurable"
  | "reclaimStaleHostsDurable"
  | "reconcileRepositoryDrainsDurable"
  | "assignQueuedDurable"
  | "assignScheduledQueuedDurable"
>;

export type LocalSchedulerOptions = {
  /** Defaults to the production cron cadence (one minute). */
  intervalMs?: number;
  /** Observes a failed operation; the next operation and later ticks still run. */
  onError?: (error: unknown) => void;
};

/**
 * Drives the durable scheduler paths while the local API is listening.
 *
 * A tick deliberately shares the operations used by the admin endpoints. That
 * keeps local development faithful to the deployed cron/scheduler split while
 * making a failed storage operation retry naturally on a later tick.
 */
export class LocalScheduler {
  private readonly plane: SchedulerPlane;
  private readonly intervalMs: number;
  private readonly onError: ((error: unknown) => void) | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight: Promise<void> | undefined;
  private started = false;

  constructor(plane: SchedulerPlane, options: LocalSchedulerOptions = {}) {
    this.plane = plane;
    this.intervalMs = options.intervalMs ?? DEFAULT_LOCAL_SCHEDULER_INTERVAL_MS;
    this.onError = options.onError ?? reportSchedulerError;
    if (!Number.isFinite(this.intervalMs) || this.intervalMs <= 0) {
      throw new RangeError("local scheduler intervalMs must be a positive finite number");
    }
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    this.timer.unref();
    void this.tick();
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.inFlight;
  }

  /** Runs one complete sweep, returning false when a sweep is already active. */
  async tick(): Promise<boolean> {
    if (!this.started || this.inFlight) return false;
    const tick = this.runTick();
    this.inFlight = tick;
    try {
      await tick;
      return true;
    } finally {
      if (this.inFlight === tick) this.inFlight = undefined;
    }
  }

  private async runTick(): Promise<void> {
    const steps = [
      () => this.plane.evaluateCronDurable(),
      () => this.plane.enforceAckDeadlinesDurable(),
      () => this.plane.enforceRunningTimeoutsDurable(),
      () => this.plane.reclaimStaleHostsDurable(),
      () => this.plane.reconcileRepositoryDrainsDurable(),
      () => this.plane.assignQueuedDurable(),
      () => this.plane.assignScheduledQueuedDurable(),
    ];
    for (const step of steps) {
      if (!this.started) return;
      await this.runStep(step);
    }
  }

  private async runStep(step: () => Promise<unknown>): Promise<void> {
    try {
      await step();
    } catch (error) {
      try {
        this.onError?.(error);
      } catch {
        // Observability must not stop the dispatcher from reaching later steps.
      }
    }
  }
}
