import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { DaemonLoop } from "./daemon-loop.ts";
import {
  createAcknowledgingLoopbackTransport,
  makeRepo,
} from "../test-helpers/daemon-loop-test-helpers.ts";
import { writeStoredSetupCache } from "./setup-script-cache.ts";

type SweepInternals = {
  expireSetupCache: () => Promise<void>;
  scheduleSetupCacheSweep: () => void;
};

describe("DaemonLoop setup-cache sweep queue", () => {
  it("queues a second sweep while one is in flight", async () => {
    const { config, cleanup } = await makeRepo();
    const cacheDir = await mkdtemp(join(tmpdir(), "ah-loop-setup-cache-queue-"));
    await writeStoredSetupCache(cacheDir, "orphan", join(cacheDir, "orphan"), "fp", {});
    try {
      const transport = createAcknowledgingLoopbackTransport({ sendToServer: () => undefined });
      const leftover: Array<() => void> = [];
      const loop = new DaemonLoop({
        config,
        transport,
        setupCacheDir: cacheDir,
        setupCacheSweepDelayMs: 17,
        timers: {
          setTimeout: (callback, ms) => {
            if (ms === 17) leftover.push(callback);
            return leftover.length as never;
          },
          clearTimeout: () => undefined,
        },
      });
      const internals = loop as unknown as SweepInternals;
      const first = internals.expireSetupCache();
      const second = internals.expireSetupCache();
      await first;
      await second;
      expect(leftover.length).toBeGreaterThanOrEqual(1);
      loop.stop();
    } finally {
      cleanup();
    }
  });

  it("does not schedule a sweep without a cache directory", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const leftover: Array<() => void> = [];
      const transport = createAcknowledgingLoopbackTransport({ sendToServer: () => undefined });
      const loop = new DaemonLoop({
        config,
        transport,
        setupCacheSweepDelayMs: 17,
        timers: {
          setTimeout: (callback, ms) => {
            if (ms === 17) leftover.push(callback);
            return leftover.length as never;
          },
          clearTimeout: () => undefined,
        },
      });
      await loop.start();
      (loop as unknown as SweepInternals).scheduleSetupCacheSweep();
      expect(leftover).toEqual([]);
      loop.stop();
    } finally {
      cleanup();
    }
  });
});
