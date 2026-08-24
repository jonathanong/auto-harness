import { afterEach, describe, expect, it, vi } from "vitest";

import { emptyDaemonConfig, HostInventoryPolicyError } from "./bootstrap.ts";
import { startInventoryPoll } from "./start-daemon.ts";

const identity = { hostId: "host-1", apiUrl: "http://control.test", logLevel: "info" as const };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("inventory poll boundary coverage", () => {
  it("uses global fetch when no override is supplied", async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn(async () => Response.json({ repositories: [], commandProfiles: {} }));
    vi.stubGlobal("fetch", fetchFn);
    const stop = startInventoryPoll({
      config: emptyDaemonConfig(identity),
      identity,
      applyInventory: async () => undefined,
      pollMs: 10,
      log: () => undefined,
      error: () => undefined,
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(fetchFn).toHaveBeenCalledOnce();
    await stop();
  });

  it("formats primitive fetch failures", async () => {
    vi.useFakeTimers();
    const errors: string[] = [];
    const stop = startInventoryPoll({
      config: emptyDaemonConfig(identity),
      identity,
      applyInventory: async () => undefined,
      pollMs: 10,
      fetchFn: async () => {
        throw "primitive failure";
      },
      log: () => undefined,
      error: (line) => errors.push(line),
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(errors).toEqual(["inventory poll failed: primitive failure"]);
    await stop();
  });

  it("reports a failed policy drain while retaining the blocked poll state", async () => {
    vi.useFakeTimers();
    const errors: string[] = [];
    const stop = startInventoryPoll({
      config: emptyDaemonConfig(identity),
      identity,
      applyInventory: async () => undefined,
      pollMs: 10,
      fetchFn: async () => {
        throw new HostInventoryPolicyError(new Error("outside root"), ["/safe/root"]);
      },
      blockAssignments: async () => {
        throw new Error("drain unavailable");
      },
      log: () => undefined,
      error: (line) => errors.push(line),
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(errors).toEqual([
      "inventory policy drain failed: drain unavailable",
      "inventory poll failed: host inventory violates its allowed-roots policy: outside root",
    ]);
    await stop();
  });
});
