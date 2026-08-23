import { describe, expect, it, vi } from "vitest";

import { DEFAULT_LOCAL_SCHEDULER_INTERVAL_MS, LocalScheduler } from "./local-scheduler.ts";

type Step = () => Promise<unknown>;

function makePlane(steps: Partial<Record<string, Step>> = {}): {
  calls: string[];
  plane: ConstructorParameters<typeof LocalScheduler>[0];
} {
  const calls: string[] = [];
  const step =
    (name: string): Step =>
    async () => {
      calls.push(name);
      await steps[name]?.();
    };
  return {
    calls,
    plane: {
      evaluateCronDurable: step("cron"),
      enforceAckDeadlinesDurable: step("ack"),
      enforceRunningTimeoutsDurable: step("timeout"),
      reclaimStaleHostsDurable: step("stale"),
      reconcileRepositoryDrainsDurable: step("repository-drains"),
      assignQueuedDurable: step("queued"),
      assignScheduledQueuedDurable: step("scheduled"),
    },
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

describe("LocalScheduler", () => {
  it("runs every durable scheduler operation immediately and at its configured cadence", async () => {
    vi.useFakeTimers();
    try {
      const { calls, plane } = makePlane();
      const scheduler = new LocalScheduler(plane, { intervalMs: 10 });

      scheduler.start();
      await flush();
      expect(calls).toEqual([
        "cron",
        "ack",
        "timeout",
        "stale",
        "repository-drains",
        "queued",
        "scheduled",
      ]);

      scheduler.start();
      await vi.advanceTimersByTimeAsync(10);
      expect(calls).toHaveLength(14);
      await scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not overlap ticks and stops remaining work during shutdown", async () => {
    let releaseCron: (() => void) | undefined;
    const cron = new Promise<void>((resolve) => {
      releaseCron = resolve;
    });
    const { calls, plane } = makePlane({ cron: async () => cron });
    const scheduler = new LocalScheduler(plane);

    expect(await scheduler.tick()).toBe(false);
    scheduler.start();
    await flush();
    expect(calls).toEqual(["cron"]);
    expect(await scheduler.tick()).toBe(false);

    const stopped = scheduler.stop();
    releaseCron?.();
    await stopped;
    expect(calls).toEqual(["cron"]);

    scheduler.start();
    await flush();
    expect(calls).toEqual([
      "cron",
      "cron",
      "ack",
      "timeout",
      "stale",
      "repository-drains",
      "queued",
      "scheduled",
    ]);
    await scheduler.stop();
  });

  it("continues after transient operation and observer failures", async () => {
    const errors: unknown[] = [];
    const { calls, plane } = makePlane({
      cron: async () => {
        throw new Error("temporary DynamoDB failure");
      },
    });
    const scheduler = new LocalScheduler(plane, {
      onError: (error) => {
        errors.push(error);
        throw new Error("observer failure");
      },
    });

    scheduler.start();
    await flush();
    expect(errors).toHaveLength(1);
    expect(calls).toEqual([
      "cron",
      "ack",
      "timeout",
      "stale",
      "repository-drains",
      "queued",
      "scheduled",
    ]);
    await scheduler.stop();
  });

  it("reports a failed operation to the default local logger", async () => {
    const error = new Error("temporary DynamoDB failure");
    const logger = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { calls, plane } = makePlane({
        cron: async () => {
          throw error;
        },
      });
      const scheduler = new LocalScheduler(plane);

      scheduler.start();
      await flush();
      expect(logger).toHaveBeenCalledWith("local scheduler operation failed", error);
      expect(calls).toEqual([
        "cron",
        "ack",
        "timeout",
        "stale",
        "repository-drains",
        "queued",
        "scheduled",
      ]);
      await scheduler.stop();
    } finally {
      logger.mockRestore();
    }
  });

  it("uses a one-minute default and rejects invalid intervals", async () => {
    const { plane } = makePlane();
    const scheduler = new LocalScheduler(plane);
    expect(DEFAULT_LOCAL_SCHEDULER_INTERVAL_MS).toBe(60_000);
    expect(scheduler).toBeInstanceOf(LocalScheduler);
    expect(() => new LocalScheduler(plane, { intervalMs: 0 })).toThrow(RangeError);
    expect(() => new LocalScheduler(plane, { intervalMs: Number.POSITIVE_INFINITY })).toThrow(
      "positive finite",
    );
    await scheduler.stop();
  });
});
