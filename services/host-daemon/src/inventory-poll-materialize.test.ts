import { afterEach, describe, expect, it, vi } from "vitest";

import { emptyDaemonConfig } from "./bootstrap.ts";
import type { HostIdentity } from "./config-types.ts";
import { startInventoryPoll } from "./start-daemon.ts";

const identity: HostIdentity = {
  hostId: "agent-loop",
  apiUrl: "http://control-plane.test",
  logLevel: "info",
};

const updatedInventory = {
  repositories: [{ id: "demo", path: "/tmp/demo", defaultBranch: "main", worktrees: [] }],
  commandProfiles: {},
};

function inventoryFetch(inventory: typeof updatedInventory): typeof fetch {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(inventory), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  ) as typeof fetch;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("startInventoryPoll worktree materialization", () => {
  it("kicks worktree materialization on every tick, even while an apply is in flight", async () => {
    vi.useFakeTimers();
    const config = emptyDaemonConfig(identity);
    const materializeWorktrees = vi.fn();
    const stop = startInventoryPoll({
      config,
      identity,
      applyInventory: () => new Promise<void>(() => {}),
      materializeWorktrees,
      pollMs: 10,
      fetchFn: inventoryFetch(updatedInventory),
      log: () => {},
      error: () => {},
    });
    try {
      await vi.advanceTimersByTimeAsync(30);
      expect(materializeWorktrees).toHaveBeenCalledTimes(3);
    } finally {
      void stop();
    }
  });
});
