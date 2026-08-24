import { afterEach, describe, expect, it, vi } from "vitest";

import { emptyDaemonConfig, HostInventoryPolicyError } from "./bootstrap.ts";
import type { DaemonConfig, HostIdentity } from "./config-types.ts";
import { startInventoryPoll } from "./start-daemon.ts";

const identity: HostIdentity = {
  hostId: "agent-loop",
  apiUrl: "http://control-plane.test",
  logLevel: "info",
};

const updatedInventory = {
  repositories: [
    {
      id: "demo",
      path: "/tmp/demo",
      defaultBranch: "main",
      worktrees: [],
    },
  ],
  commandProfiles: {
    "echo-prompt": { argv: ["printf", "%s"] },
  },
};

afterEach(() => {
  vi.useRealTimers();
});

describe("startInventoryPoll", () => {
  it("retries an unchanged inventory after an apply failure", async () => {
    vi.useFakeTimers();
    const config = emptyDaemonConfig(identity);
    const applied: DaemonConfig[] = [];
    let attempts = 0;
    const applyInventory = vi.fn(async (next: DaemonConfig) => {
      applied.push(next);
      attempts += 1;
      if (attempts === 1) throw new Error("git apply failed");
    });
    const errors: string[] = [];
    const logs: string[] = [];
    const fetchFn = inventoryFetch(updatedInventory);
    const stop = startInventoryPoll({
      config,
      identity,
      applyInventory,
      pollMs: 10,
      fetchFn,
      log: (line) => logs.push(line),
      error: (line) => errors.push(line),
    });

    try {
      await vi.advanceTimersByTimeAsync(10);
      expect(applyInventory).toHaveBeenCalledTimes(1);
      expect(errors).toEqual(["inventory poll failed: git apply failed"]);

      await vi.advanceTimersByTimeAsync(10);
      expect(applyInventory).toHaveBeenCalledTimes(2);
      expect(applied[1]).toEqual(applied[0]);
      expect(errors).toHaveLength(1);
      expect(logs).toEqual(["host inventory updated from control plane (1 repo(s))"]);
    } finally {
      await stop();
    }
  });

  it("deduplicates successful identical polls", async () => {
    vi.useFakeTimers();
    const config = emptyDaemonConfig(identity);
    const applyInventory = vi.fn(async (_next: DaemonConfig) => {});
    const logs: string[] = [];
    const stop = startInventoryPoll({
      config,
      identity,
      applyInventory,
      pollMs: 10,
      fetchFn: inventoryFetch(updatedInventory),
      log: (line) => logs.push(line),
      error: () => {},
    });

    try {
      await vi.advanceTimersByTimeAsync(20);
      expect(applyInventory).toHaveBeenCalledTimes(1);
      expect(logs).toHaveLength(1);
    } finally {
      await stop();
    }
  });

  it("does not overlap a slow apply with another poll", async () => {
    vi.useFakeTimers();
    const config = emptyDaemonConfig(identity);
    let resolveApply!: () => void;
    const applyInventory = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveApply = resolve;
        }),
    );
    const fetchFn = inventoryFetch(updatedInventory);
    const stop = startInventoryPoll({
      config,
      identity,
      applyInventory,
      pollMs: 10,
      fetchFn,
      log: () => {},
      error: () => {},
    });

    try {
      await vi.advanceTimersByTimeAsync(10);
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(applyInventory).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(10);
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(applyInventory).toHaveBeenCalledTimes(1);

      resolveApply();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(10);
      expect(fetchFn).toHaveBeenCalledTimes(2);
      expect(applyInventory).toHaveBeenCalledTimes(1);
    } finally {
      await stop();
    }
  });

  it("waits for an in-flight apply during shutdown", async () => {
    vi.useFakeTimers();
    const config = emptyDaemonConfig(identity);
    let resolveApply!: () => void;
    const applyInventory = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveApply = resolve;
        }),
    );
    const fetchFn = inventoryFetch(updatedInventory);
    const stop = startInventoryPoll({
      config,
      identity,
      applyInventory,
      pollMs: 10,
      fetchFn,
      log: () => {},
      error: () => {},
    });

    await vi.advanceTimersByTimeAsync(10);
    expect(applyInventory).toHaveBeenCalledTimes(1);
    let stopped = false;
    const stopping = stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(20);
    expect(stopped).toBe(false);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    resolveApply();
    await stopping;
    expect(stopped).toBe(true);
    await vi.advanceTimersByTimeAsync(20);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("blocks assignments for an invalid root policy, keeps polling, and reapplies a valid policy", async () => {
    vi.useFakeTimers();
    const config = emptyDaemonConfig(identity);
    let calls = 0;
    const fetchFn = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        throw new HostInventoryPolicyError(new Error("no usable allowed roots"));
      }
      return Response.json(updatedInventory);
    }) as typeof fetch;
    const applyInventory = vi.fn(async (_next: DaemonConfig) => {});
    const blockAssignments = vi.fn(async () => {});
    const errors: string[] = [];
    const stop = startInventoryPoll({
      config,
      identity,
      applyInventory,
      blockAssignments,
      pollMs: 10,
      fetchFn,
      log: () => {},
      error: (line) => errors.push(line),
    });

    try {
      await vi.advanceTimersByTimeAsync(10);
      expect(blockAssignments).toHaveBeenCalledOnce();
      expect(applyInventory).not.toHaveBeenCalled();
      expect(errors[0]).toContain("allowed-roots policy");

      await vi.advanceTimersByTimeAsync(10);
      expect(applyInventory).toHaveBeenCalledOnce();
    } finally {
      await stop();
    }
  });
});

function inventoryFetch(inventory: typeof updatedInventory): typeof fetch {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(inventory), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  ) as typeof fetch;
}
