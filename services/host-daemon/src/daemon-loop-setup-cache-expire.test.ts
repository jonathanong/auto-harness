import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { DaemonLoop } from "./daemon-loop.ts";
import {
  createAcknowledgingLoopbackTransport,
  makeRepo,
} from "../test-helpers/daemon-loop-test-helpers.ts";
import { setupCacheFileName, writeStoredSetupCache } from "./setup-script-cache.ts";

type SweepInternals = {
  expireSetupCache: () => Promise<void>;
  scheduleSetupCacheSweep: () => void;
  runner: { deps: { onSetupCacheClaimReleased?: () => void } };
};

describe("DaemonLoop setup-cache expiry", () => {
  it("sweeps orphans on start and after a worktree is removed", async () => {
    const { config, root, cleanup } = await makeRepo();
    const cacheDir = await mkdtemp(join(tmpdir(), "ah-loop-setup-cache-"));
    const live = config.repositories[0]!.worktrees[0]!;
    const oldPath = join(root, "wt-old");
    await writeStoredSetupCache(cacheDir, live.id, live.path, "fp", { A: "1" });
    await writeStoredSetupCache(cacheDir, live.id, oldPath, "fp", { B: "2" });
    await writeStoredSetupCache(cacheDir, "removed", live.path, "fp", { C: "3" });
    try {
      const transport = createAcknowledgingLoopbackTransport({ sendToServer: () => undefined });
      const loop = new DaemonLoop({ config, transport, setupCacheDir: cacheDir });
      await loop.start();
      expect(await readdir(cacheDir)).toEqual([setupCacheFileName(live.id, live.path)]);

      await loop.applyInventory({
        ...config,
        repositories: config.repositories.map((repository) => ({
          ...repository,
          worktrees: [],
        })),
      });
      expect(await readdir(cacheDir)).toEqual([]);
      loop.stop();
    } finally {
      cleanup();
    }
  });

  it("schedules another bounded batch after a capped sweep without an inventory change", async () => {
    const { config, cleanup } = await makeRepo();
    const cacheDir = await mkdtemp(join(tmpdir(), "ah-loop-setup-cache-cap-"));
    const live = config.repositories[0]!.worktrees[0]!;
    await writeStoredSetupCache(cacheDir, live.id, live.path, "fp", { A: "1" });
    for (const id of ["a", "b", "c"]) {
      await writeStoredSetupCache(cacheDir, id, join(cacheDir, id), "fp", {});
    }
    const leftover: Array<() => void> = [];
    let unrefed = false;
    try {
      const transport = createAcknowledgingLoopbackTransport({ sendToServer: () => undefined });
      const loop = new DaemonLoop({
        config,
        transport,
        setupCacheDir: cacheDir,
        setupCacheSweepMaxUnlinks: 2,
        setupCacheSweepMaxEntries: 8,
        setupCacheSweepDelayMs: 17,
        timers: {
          setTimeout: (callback, ms) => {
            if (ms === 17) leftover.push(callback);
            return {
              unref: () => {
                unrefed = true;
              },
            } as never;
          },
          clearTimeout: () => undefined,
        },
      });
      await loop.start();
      expect(unrefed).toBe(true);
      expect(leftover).toHaveLength(1);
      (loop as unknown as SweepInternals).runner.deps.onSetupCacheClaimReleased?.();
      expect(leftover).toHaveLength(1);
      expect((await readdir(cacheDir)).length).toBeGreaterThan(1);
      leftover[0]!();
      await vi.waitFor(async () => {
        expect(await readdir(cacheDir)).toEqual([setupCacheFileName(live.id, live.path)]);
      });
      loop.stop();
    } finally {
      cleanup();
    }
  });

  it("sweeps a sidecar written after its worktree was removed when the claim is released", async () => {
    const { config, cleanup } = await makeRepo();
    const cacheDir = await mkdtemp(join(tmpdir(), "ah-loop-setup-cache-claim-"));
    const live = config.repositories[0]!.worktrees[0]!;
    const leftover: Array<() => void> = [];
    try {
      const transport = createAcknowledgingLoopbackTransport({ sendToServer: () => undefined });
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
      await loop.start();
      await loop.applyInventory({
        ...config,
        repositories: config.repositories.map((repository) => ({
          ...repository,
          worktrees: [],
        })),
      });
      await writeStoredSetupCache(cacheDir, live.id, live.path, "fp", { A: "1" });
      expect(await readdir(cacheDir)).toEqual([setupCacheFileName(live.id, live.path)]);
      const internals = loop as unknown as SweepInternals;
      internals.runner.deps.onSetupCacheClaimReleased?.();
      expect(leftover).toHaveLength(1);
      leftover[0]!();
      await vi.waitFor(async () => {
        expect(await readdir(cacheDir)).toEqual([]);
      });
      loop.stop();
    } finally {
      cleanup();
    }
  });

  it("clears a leftover setup-cache sweep on stop", async () => {
    const { config, cleanup } = await makeRepo();
    const cacheDir = await mkdtemp(join(tmpdir(), "ah-loop-setup-cache-stop-"));
    for (const id of ["a", "b"]) {
      await writeStoredSetupCache(cacheDir, id, join(cacheDir, id), "fp", {});
    }
    let cleared = false;
    try {
      const transport = createAcknowledgingLoopbackTransport({ sendToServer: () => undefined });
      const loop = new DaemonLoop({
        config,
        transport,
        setupCacheDir: cacheDir,
        setupCacheSweepMaxUnlinks: 1,
        setupCacheSweepDelayMs: 17,
        timers: {
          setTimeout: (_callback, ms) => (ms === 17 ? (7 as never) : (1 as never)),
          clearTimeout: (id) => {
            if (id === 7) cleared = true;
          },
        },
      });
      await loop.start();
      loop.stop();
      expect(cleared).toBe(true);
      (loop as unknown as SweepInternals).scheduleSetupCacheSweep();
      await writeStoredSetupCache(cacheDir, "late", join(cacheDir, "late"), "fp", {});
      const before = await readdir(cacheDir);
      await (loop as unknown as SweepInternals).expireSetupCache();
      expect(await readdir(cacheDir)).toEqual(before);
    } finally {
      cleanup();
    }
  });
});
