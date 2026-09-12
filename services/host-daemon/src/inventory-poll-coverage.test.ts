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

  it("rate-limits repeated identical poll failures instead of logging every tick", async () => {
    vi.useFakeTimers();
    const errors: string[] = [];
    const stop = startInventoryPoll({
      config: emptyDaemonConfig(identity),
      identity,
      applyInventory: async () => undefined,
      pollMs: 10,
      errorLogIntervalMs: 100,
      fetchFn: async () => {
        throw new Error("bootstrap failed (500)");
      },
      log: () => undefined,
      error: (line) => errors.push(line),
    });
    // 10 ticks at pollMs=10 span 100ms -- the same window the incident this
    // guards against saw hundreds of identical lines at a 15s cadence.
    await vi.advanceTimersByTimeAsync(100);
    expect(errors).toEqual(["inventory poll failed: bootstrap failed (500)"]);
    await vi.advanceTimersByTimeAsync(100);
    expect(errors).toEqual([
      "inventory poll failed: bootstrap failed (500)",
      "inventory poll failed: bootstrap failed (500) (repeated 9 time(s) since last log)",
    ]);
    await stop();
  });

  it("logs a failure fresh (no stale repeat count) after a poll recovers in between", async () => {
    vi.useFakeTimers();
    const errors: string[] = [];
    let calls = 0;
    const stop = startInventoryPoll({
      config: emptyDaemonConfig(identity),
      identity,
      applyInventory: async () => undefined,
      pollMs: 10,
      errorLogIntervalMs: 100_000,
      fetchFn: async () => {
        calls += 1;
        // Fail, then recover (unchanged inventory -- the early-return success
        // path), then fail again with the exact same message.
        if (calls === 2) return Response.json({ repositories: [], commandProfiles: {} });
        throw new Error("bootstrap failed (500)");
      },
      log: () => undefined,
      error: (line) => errors.push(line),
    });
    await vi.advanceTimersByTimeAsync(30);
    // Without a reset on recovery, the third failure would be suppressed (still
    // "identical" and well inside errorLogIntervalMs) instead of logging fresh.
    expect(errors).toEqual([
      "inventory poll failed: bootstrap failed (500)",
      "inventory poll failed: bootstrap failed (500)",
    ]);
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

  it("stringifies a non-Error policy drain failure", async () => {
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
        throw "drain-offline";
      },
      log: () => undefined,
      error: (line) => errors.push(line),
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(errors).toEqual([
      "inventory policy drain failed: drain-offline",
      "inventory poll failed: host inventory violates its allowed-roots policy: outside root",
    ]);
    await stop();
  });
});
