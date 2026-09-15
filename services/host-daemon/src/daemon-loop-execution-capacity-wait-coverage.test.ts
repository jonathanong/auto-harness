import { describe, expect, it } from "vitest";

import { DaemonLoop, createLoopbackTransport } from "./daemon-loop.ts";
import { flushMacrotask, makeRepo } from "../test-helpers/daemon-loop-test-helpers.ts";

type CapacityInternals = {
  acquireExecutionSlot(
    entry: { executing: boolean },
    signal: AbortSignal,
    occupy?: () => void,
  ): Promise<boolean>;
  waitForExecutionCapacityChange(signal: AbortSignal): Promise<boolean>;
  hasSpareExecutionCapacity(): boolean;
  notifyExecutionCapacityWaiters(): void;
  activeTerminalHookHandoffs: number;
  executionCapacityWaiters: Set<() => void>;
};

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await flushMacrotask();
  }
  throw new Error("condition did not become true");
}

describe("DaemonLoop execution capacity wait coverage", () => {
  it("finishes a capacity wait immediately when a slot is already spare after registering", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const loop = new DaemonLoop({
        config,
        transport: createLoopbackTransport(),
        executionProfiles: { maxConcurrentAssignments: 1, profiles: new Map() },
      });
      const internals = loop as unknown as CapacityInternals;
      internals.activeTerminalHookHandoffs = 1;
      let checks = 0;
      internals.hasSpareExecutionCapacity = () => {
        checks += 1;
        return checks > 1;
      };
      const entry = { executing: false };
      await expect(
        internals.acquireExecutionSlot(entry, new AbortController().signal),
      ).resolves.toBe(true);
      expect(entry.executing).toBe(true);
      expect(checks).toBeGreaterThanOrEqual(2);
      expect(internals.executionCapacityWaiters.size).toBe(0);
    } finally {
      cleanup();
    }
  });

  it("returns false from acquireExecutionSlot when the capacity wait is aborted", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const loop = new DaemonLoop({
        config,
        transport: createLoopbackTransport(),
        executionProfiles: { maxConcurrentAssignments: 1, profiles: new Map() },
      });
      const internals = loop as unknown as CapacityInternals;
      internals.activeTerminalHookHandoffs = 1;
      const entry = { executing: false };
      const controller = new AbortController();
      const pending = internals.acquireExecutionSlot(entry, controller.signal);
      await waitFor(() => internals.executionCapacityWaiters.size === 1);
      controller.abort();
      await expect(pending).resolves.toBe(false);
      expect(entry.executing).toBe(false);
      expect(internals.executionCapacityWaiters.size).toBe(0);
    } finally {
      cleanup();
    }
  });

  it("returns false when a capacity wakeup races with abort before the next loop check", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const loop = new DaemonLoop({
        config,
        transport: createLoopbackTransport(),
        executionProfiles: { maxConcurrentAssignments: 1, profiles: new Map() },
      });
      const internals = loop as unknown as CapacityInternals;
      internals.activeTerminalHookHandoffs = 1;
      const entry = { executing: false };
      const controller = new AbortController();
      const pending = internals.acquireExecutionSlot(entry, controller.signal);
      await waitFor(() => internals.executionCapacityWaiters.size === 1);
      internals.notifyExecutionCapacityWaiters();
      controller.abort();
      await expect(pending).resolves.toBe(false);
      expect(entry.executing).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("wakes the next waiter when occupy still leaves spare capacity", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const loop = new DaemonLoop({
        config,
        transport: createLoopbackTransport(),
        executionProfiles: { maxConcurrentAssignments: 2, profiles: new Map() },
      });
      const internals = loop as unknown as CapacityInternals;
      const entry = { executing: false };
      let occupied = false;
      let woken = 0;
      internals.executionCapacityWaiters.add(() => {
        woken += 1;
      });
      await expect(
        internals.acquireExecutionSlot(entry, new AbortController().signal, () => {
          occupied = true;
        }),
      ).resolves.toBe(true);
      expect(occupied).toBe(true);
      expect(entry.executing).toBe(true);
      expect(woken).toBe(1);
    } finally {
      cleanup();
    }
  });

  it("resolves false immediately when the signal is already aborted before the wait begins", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const loop = new DaemonLoop({
        config,
        transport: createLoopbackTransport(),
        executionProfiles: { maxConcurrentAssignments: 1, profiles: new Map() },
      });
      const internals = loop as unknown as CapacityInternals;
      const controller = new AbortController();
      controller.abort();
      await expect(internals.waitForExecutionCapacityChange(controller.signal)).resolves.toBe(
        false,
      );
      expect(internals.executionCapacityWaiters.size).toBe(0);
    } finally {
      cleanup();
    }
  });

  it("resolves false via the post-registration recheck when abort lands between entry and listener setup", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const loop = new DaemonLoop({
        config,
        transport: createLoopbackTransport(),
        executionProfiles: { maxConcurrentAssignments: 1, profiles: new Map() },
      });
      const internals = loop as unknown as CapacityInternals;
      // A signal whose `aborted` getter only turns true after the entry check
      // has already passed, modelling an abort that lands between that guard
      // and the listener registration a few lines later.
      let reads = 0;
      const racingSignal = {
        get aborted() {
          reads += 1;
          return reads > 1;
        },
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      } as unknown as AbortSignal;
      await expect(internals.waitForExecutionCapacityChange(racingSignal)).resolves.toBe(false);
      expect(internals.executionCapacityWaiters.size).toBe(0);
    } finally {
      cleanup();
    }
  });

  it("ignores a redundant settle when a reentrant capacity notification races the synchronous availability check", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const loop = new DaemonLoop({
        config,
        transport: createLoopbackTransport(),
        executionProfiles: { maxConcurrentAssignments: 1, profiles: new Map() },
      });
      const internals = loop as unknown as CapacityInternals;
      const controller = new AbortController();
      let calls = 0;
      // Model a capacity release that reentrantly wakes this exact waiter
      // (via notifyExecutionCapacityWaiters) while this wait's own synchronous
      // availability check is still in progress. The waiter must settle once,
      // from whichever source resolves it first; the second settle attempt
      // has to be a no-op rather than a double resolve/cleanup.
      internals.hasSpareExecutionCapacity = () => {
        calls += 1;
        if (calls === 1) internals.notifyExecutionCapacityWaiters();
        return true;
      };
      await expect(internals.waitForExecutionCapacityChange(controller.signal)).resolves.toBe(true);
      expect(internals.executionCapacityWaiters.size).toBe(0);
    } finally {
      cleanup();
    }
  });
});
