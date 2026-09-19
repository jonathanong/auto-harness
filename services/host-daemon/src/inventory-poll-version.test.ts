import { afterEach, describe, expect, it, vi } from "vitest";

import { emptyDaemonConfig } from "./bootstrap.ts";
import type { DaemonConfig, HostIdentity } from "./config-types.ts";
import { startInventoryPoll } from "./start-daemon.ts";

const identity: HostIdentity = {
  hostId: "version-loop",
  apiUrl: "http://control-plane.test",
  logLevel: "info",
};

afterEach(() => vi.useRealTimers());

describe("inventory poll version changes", () => {
  it("does not apply a server-managed version change when effective inventory is unchanged", async () => {
    vi.useFakeTimers();
    const config = { ...emptyDaemonConfig(identity), inventoryVersion: 1 };
    const applyInventory = vi.fn(async (_next: DaemonConfig) => {});
    const logs: string[] = [];
    let version = 1;
    const fetchFn = vi.fn(async () =>
      Response.json({ version: ++version, repositories: [], providerAccounts: [] }),
    ) as typeof fetch;
    const stop = startInventoryPoll({
      config,
      identity,
      applyInventory,
      pollMs: 10,
      fetchFn,
      log: (line) => logs.push(line),
      error: () => {},
    });

    try {
      await vi.advanceTimersByTimeAsync(20);
      expect(fetchFn).toHaveBeenCalledTimes(2);
      expect(applyInventory).not.toHaveBeenCalled();
      expect(logs).toEqual([]);
    } finally {
      await stop();
    }
  });

  it("skips the production reload path for version-only changes", async () => {
    vi.useFakeTimers();
    const config = { ...emptyDaemonConfig(identity), inventoryVersion: 10 };
    const applied: DaemonConfig[] = [];
    let version = 10;
    const reloadInventory = vi.fn(
      async (
        loadInventory: (signal: AbortSignal) => Promise<DaemonConfig>,
        shouldApply: (next: DaemonConfig) => boolean,
      ) => {
        const next = await loadInventory(new AbortController().signal);
        if (shouldApply(next)) applied.push(next);
        return next;
      },
    );
    const stop = startInventoryPoll({
      config,
      identity,
      applyInventory: async () => {},
      reloadInventory,
      pollMs: 10,
      fetchFn: vi.fn(async () =>
        Response.json({ version: ++version, repositories: [], providerAccounts: [] }),
      ) as typeof fetch,
      log: () => {},
      error: () => {},
    });

    try {
      await vi.advanceTimersByTimeAsync(20);
      expect(reloadInventory).toHaveBeenCalledTimes(2);
      expect(applied).toEqual([]);
    } finally {
      await stop();
    }
  });
});
