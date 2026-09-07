export type RepeatedLogSuppressorOptions = {
  /** Minimum time between repeated log lines for the same message. */
  minIntervalMs: number;
  nowMs?: () => number;
};

/**
 * Suppresses an immediately-repeated identical log line, while still
 * surfacing a periodic reminder (with a repeat count) so a stuck failure
 * doesn't go completely silent. A message that differs from the last one
 * always logs immediately -- only a run of *identical* messages is throttled.
 */
export class RepeatedLogSuppressor {
  private readonly minIntervalMs: number;
  private readonly nowMs: () => number;
  private lastMessage: string | undefined;
  private lastEmittedAt = -Infinity;
  private suppressedSinceEmit = 0;

  constructor(options: RepeatedLogSuppressorOptions) {
    this.minIntervalMs = options.minIntervalMs;
    this.nowMs = options.nowMs ?? Date.now;
  }

  /** Returns the line to log, or undefined if this occurrence should stay suppressed. */
  next(message: string): string | undefined {
    const now = this.nowMs();
    if (message !== this.lastMessage) {
      this.lastMessage = message;
      this.lastEmittedAt = now;
      this.suppressedSinceEmit = 0;
      return message;
    }
    if (now - this.lastEmittedAt < this.minIntervalMs) {
      this.suppressedSinceEmit += 1;
      return undefined;
    }
    const suppressed = this.suppressedSinceEmit;
    this.lastEmittedAt = now;
    this.suppressedSinceEmit = 0;
    return suppressed > 0 ? `${message} (repeated ${suppressed} time(s) since last log)` : message;
  }
}
