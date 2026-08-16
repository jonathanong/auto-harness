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

  it("exits after logging, rather than leaving the process alive in an unknown state", () => {
    // Registering an unhandledRejection/uncaughtException listener at all suppresses
    // Node's default crash-on-either behavior — a listener that only logs would leave
    // the process running past the exact condition this module exists to terminate on.
    const target = fakeProcess();

    installCrashLogging({ process: target as never, logger: () => {} });
    target.emit("unhandledRejection", new Error("boom"));

    expect(target.exits).toEqual([1]);

    target.emit("uncaughtException", new Error("bang"));

    expect(target.exits).toEqual([1, 1]);
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
    vi.useFakeTimers();
    try {
      const target = fakeProcess();
      const logged: string[] = [];

      const handle = onShutdownSignal(async () => Promise.reject(new Error("drain failed")), {
        process: target as never,
        timeoutMs: 5_000,
        logger: (message) => logged.push(message),
      });

      await expect(handle.shutdown()).resolves.toBeUndefined();
      expect(logged).toContain("error during shutdown");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the forced-exit deadline armed when stop rejects, rather than treating the caught error as done", async () => {
    // A caller (cli.ts) resolves its own outer promise only after `await stop()`
    // succeeds inside the callback it hands to onShutdownSignal:
    //   onShutdownSignal(async () => { await stop(); finished(); }, ...)
    // If stop() rejects, that callback rejects before reaching finished() — the
    // caller's own promise never resolves. The forced-exit deadline is the only thing
    // that still brings the process down in that case, so it must not be cancelled
    // just because the rejection was caught and logged here.
    vi.useFakeTimers();
    try {
      const target = fakeProcess();
      const handle = onShutdownSignal(async () => Promise.reject(new Error("drain failed")), {
        process: target as never,
        timeoutMs: 5_000,
        logger: () => {},
      });

      void handle.shutdown();
      await vi.advanceTimersByTimeAsync(5_000);

      expect(target.exits).toEqual([1]);
    } finally {
      vi.useRealTimers();
    }
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

  it("falls back to console.error when no logger is injected", async () => {
    vi.useFakeTimers();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const target = fakeProcess();
      installCrashLogging({ process: target as never });
      target.emit("uncaughtException", new Error("bang"));

      const handle = onShutdownSignal(() => new Promise<void>(() => {}), {
        process: target as never,
        timeoutMs: 1_000,
      });
      void handle.shutdown();
      await vi.advanceTimersByTimeAsync(1_000);

      // With an error argument, and — from the deadline path — without one.
      expect(errors).toHaveBeenCalledWith("uncaught exception", expect.any(Error));
      expect(errors).toHaveBeenCalledWith("graceful shutdown exceeded 1000ms; exiting");
    } finally {
      errors.mockRestore();
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

  it("cancels a pending deadline when disposed mid-shutdown", async () => {
    vi.useFakeTimers();
    try {
      const target = fakeProcess();
      const handle = onShutdownSignal(() => new Promise<void>(() => {}), {
        process: target as never,
        timeoutMs: 1_000,
        logger: () => {},
      });

      void handle.shutdown();
      handle.dispose();
      await vi.advanceTimersByTimeAsync(5_000);

      expect(target.exits).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("binds to the real process when none is injected", () => {
    const before = process.listenerCount("SIGTERM");

    const handle = onShutdownSignal(async () => {});
    expect(process.listenerCount("SIGTERM")).toBe(before + 1);
    handle.dispose();

    expect(process.listenerCount("SIGTERM")).toBe(before);
  });
});

describe("installCrashLogging default target", () => {
  it("binds to the real process when none is injected", () => {
    const before = process.listenerCount("unhandledRejection");
    const added = () => process.listeners("unhandledRejection").slice(before);

    installCrashLogging({ logger: () => {} });
    expect(process.listenerCount("unhandledRejection")).toBe(before + 1);

    for (const listener of added()) process.off("unhandledRejection", listener);
    for (const listener of process.listeners("uncaughtException").slice(-1)) {
      process.off("uncaughtException", listener);
    }
    expect(process.listenerCount("unhandledRejection")).toBe(before);
  });
});
