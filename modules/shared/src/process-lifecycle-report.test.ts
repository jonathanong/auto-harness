import { describe, expect, it, vi } from "vitest";

import { installCrashLogging } from "./process-lifecycle.ts";

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
    exit(code?: number) {
      exits.push(code ?? 0);
      return undefined as never;
    },
  };
}

describe("installCrashLogging report hook", () => {
  it("awaits a crash report before exiting", async () => {
    const target = fakeProcess();
    let releaseReport: (() => void) | undefined;
    const report = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseReport = resolve;
        }),
    );
    installCrashLogging({ process: target as never, logger: () => {}, report });
    target.emit("uncaughtException", new Error("bang"));
    expect(target.exits).toEqual([]);
    expect(report).toHaveBeenCalledOnce();
    releaseReport?.();
    await vi.waitFor(() => {
      expect(target.exits).toEqual([1]);
    });
  });

  it("still exits if reporting hangs or throws", async () => {
    vi.useFakeTimers();
    try {
      const hung = fakeProcess();
      installCrashLogging({
        process: hung as never,
        logger: () => {},
        report: () => new Promise(() => {}),
        reportTimeoutMs: 1_000,
      });
      hung.emit("unhandledRejection", new Error("boom"));
      expect(hung.exits).toEqual([]);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(hung.exits).toEqual([1]);
    } finally {
      vi.useRealTimers();
    }

    const throwing = fakeProcess();
    installCrashLogging({
      process: throwing as never,
      logger: () => {},
      report: async () => {
        throw new Error("sentry down");
      },
    });
    throwing.emit("uncaughtException", new Error("bang"));
    await vi.waitFor(() => {
      expect(throwing.exits).toEqual([1]);
    });
  });
});
