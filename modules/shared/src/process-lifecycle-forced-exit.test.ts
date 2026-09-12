import { describe, expect, it, vi } from "vitest";

import { installCrashLogging, onShutdownSignal } from "./process-lifecycle.ts";

type Handler = (...args: unknown[]) => void;

function fakeProcess() {
  const listeners = new Map<string, Set<Handler>>();
  const exits: number[] = [];
  return {
    exits,
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

describe("process lifecycle timer handles", () => {
  it("cancels a DOM-like zero timer id after a successful stop", async () => {
    const cancel = vi.fn();
    const target = fakeProcess();
    const handle = onShutdownSignal(async () => {}, {
      process: target as never,
      timeoutMs: 5_000,
      logger: () => {},
      setTimeout: (() => 0) as unknown as typeof setTimeout,
      clearTimeout: cancel as unknown as typeof clearTimeout,
    });

    await handle.shutdown();
    expect(cancel).toHaveBeenCalledWith(0);
    expect(target.exits).toEqual([]);
    handle.dispose();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("listens for an injected signal set", async () => {
    const target = fakeProcess();
    const stop = vi.fn(async () => {});
    const handle = onShutdownSignal(stop, {
      process: target as never,
      signals: ["SIGHUP"],
      logger: () => {},
    });
    target.emit("SIGHUP");
    await vi.waitFor(() => {
      expect(stop).toHaveBeenCalledOnce();
    });
    handle.dispose();
  });

  it("exits after a crash report even if the timeout clock cannot arm", async () => {
    const target = fakeProcess();
    installCrashLogging({
      process: target as never,
      logger: () => {},
      report: () => new Promise(() => {}),
      setTimeout: (() => {
        throw new Error("no timers");
      }) as unknown as typeof setTimeout,
    });
    target.emit("uncaughtException", new Error("bang"));
    await vi.waitFor(() => {
      expect(target.exits).toEqual([1]);
    });
  });
});
