import { describe, expect, it, vi } from "vitest";

import { installCrashLogging, onShutdownSignal } from "./process-lifecycle.ts";

type Handler = (...args: unknown[]) => void;

function fakeProcess() {
  const listeners = new Map<string, Set<Handler>>();
  const exits: number[] = [];
  return {
    exits,
    listenerCount: (event: string) => listeners.get(event)?.size ?? 0,
    emit(event: string, ...args: unknown[]) {
      for (const handler of listeners.get(event) ?? []) handler(...args);
    },
    on(event: string, handler: Handler) {
      const set = listeners.get(event) ?? new Set<Handler>();
      set.add(handler);
      listeners.set(event, set);
      return this;
    },
    off(event: string, handler: Handler) {
      listeners.get(event)?.delete(handler);
      return this;
    },
    exit(code?: number) {
      exits.push(code ?? 0);
      return undefined as never;
    },
  };
}

describe("installCrashLogging", () => {
  it("records the reason for an escaped rejection and an uncaught throw", () => {
    const target = fakeProcess();
    const logged: Array<[string, unknown]> = [];

    installCrashLogging({
      process: target as never,
      logger: (message, error) => logged.push([message, error]),
    });
    target.emit("unhandledRejection", new Error("boom"));
    target.emit("uncaughtException", new Error("bang"));

    expect(logged.map(([message]) => message)).toEqual([
      "unhandled promise rejection",
      "uncaught exception",
    ]);
    expect((logged[0]![1] as Error).message).toBe("boom");
  });
});

describe("onShutdownSignal", () => {
  it("runs the shutdown sequence once no matter how many signals arrive", async () => {
    const target = fakeProcess();
    const stop = vi.fn(async () => {});

    const handle = onShutdownSignal(stop, { process: target as never });
    target.emit("SIGINT");
    target.emit("SIGTERM");
    await handle.shutdown();

    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("swallows a rejecting stop so shutdown itself cannot crash the process", async () => {
    const target = fakeProcess();
    const logged: string[] = [];

    const handle = onShutdownSignal(async () => Promise.reject(new Error("drain failed")), {
      process: target as never,
      logger: (message) => logged.push(message),
    });

    await expect(handle.shutdown()).resolves.toBeUndefined();
    expect(logged).toContain("error during shutdown");
  });

  it("forces the process down when stop never settles", async () => {
    vi.useFakeTimers();
    try {
      const target = fakeProcess();
      const handle = onShutdownSignal(() => new Promise<void>(() => {}), {
        process: target as never,
        timeoutMs: 5_000,
        logger: () => {},
      });

      void handle.shutdown();
      expect(target.exits).toEqual([]);
      await vi.advanceTimersByTimeAsync(5_000);

      expect(target.exits).toEqual([1]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels the deadline once stop completes", async () => {
    vi.useFakeTimers();
    try {
      const target = fakeProcess();
      const handle = onShutdownSignal(async () => {}, {
        process: target as never,
        timeoutMs: 5_000,
      });

      await handle.shutdown();
      await vi.advanceTimersByTimeAsync(10_000);

      expect(target.exits).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("detaches its listeners on dispose", () => {
    const target = fakeProcess();

    const handle = onShutdownSignal(async () => {}, { process: target as never });
    expect(target.listenerCount("SIGTERM")).toBe(1);
    handle.dispose();

    expect(target.listenerCount("SIGTERM")).toBe(0);
  });
});
