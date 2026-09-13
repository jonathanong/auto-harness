import { describe, expect, it } from "vitest";

import { DaemonLoop, createLoopbackTransport } from "./daemon-loop.ts";
import { flushMacrotask, makeRepo } from "../test-helpers/daemon-loop-test-helpers.ts";

type CapacityInternals = {
  acquireExecutionSlot(entry: { executing: boolean }, signal: AbortSignal): Promise<boolean>;
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
});
