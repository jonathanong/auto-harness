import { afterEach, describe, expect, it, vi } from "vitest";

import { configureConnectionEvents } from "./daemon-connection-events.ts";

afterEach(() => vi.useRealTimers());

describe("connection events", () => {
  it("re-registers, aborts unacknowledged work immediately, and clears a recovery timer", async () => {
    vi.useFakeTimers();
    let connected: (() => void) | undefined;
    let registered: (() => void) | undefined;
    let disconnected: (() => void) | undefined;
    const calls: string[] = [];
    const events = configureConnectionEvents({
      transport: {
        send: async () => {},
        onMessage() {},
        onConnected(handler) {
          connected = handler;
        },
        onRegistered(handler) {
          registered = handler;
        },
        onDisconnected(handler) {
          disconnected = handler;
        },
        close() {},
      },
      register: async () => void calls.push("register"),
      onError: (error) => calls.push(`error:${String(error)}`),
      abortUnacknowledged: () => calls.push("unacked"),
      abortInflight: () => calls.push("all"),
      abortAfterMs: 5,
      timers: globalThis,
    });
    connected?.();
    await Promise.resolve();
    disconnected?.();
    disconnected?.();
    expect(calls).toEqual(["register", "unacked", "unacked"]);
    registered?.();
    await vi.advanceTimersByTimeAsync(5);
    expect(calls).not.toContain("all");
    disconnected?.();
    events.stop();
    connected?.();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(5);
    expect(calls).not.toContain("all");
    connected?.();
    registered?.();
    await Promise.resolve();
    expect(calls.filter((call) => call === "register")).toHaveLength(1);
    disconnected?.();
    await vi.advanceTimersByTimeAsync(5);
    expect(calls).not.toContain("all");
  });

  it("reports failed re-registration", async () => {
    let connected: (() => void) | undefined;
    const errors: unknown[] = [];
    configureConnectionEvents({
      transport: {
        send: async () => {},
        onMessage() {},
        onConnected(handler) {
          connected = handler;
        },
        close() {},
      },
      register: async () => Promise.reject(new Error("nope")),
      onError: (error) => errors.push(error),
      abortUnacknowledged() {},
      abortInflight() {},
      abortAfterMs: 1,
      timers: globalThis,
    });
    connected?.();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(errors).toEqual([expect.any(Error)]);
  });
});
