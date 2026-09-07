import { afterEach, describe, expect, it, vi } from "vitest";

import { formatLivenessLine, startLivenessLog } from "./liveness-log.ts";

afterEach(() => {
  vi.useRealTimers();
});

describe("formatLivenessLine", () => {
  it("reports no heartbeat yet and an n/a fd count", () => {
    expect(
      formatLivenessLine({
        registered: false,
        msSinceLastKeepaliveAck: undefined,
        queuedCount: 0,
        openFds: undefined,
      }),
    ).toBe("daemon liveness: registered=false last keepalive ack=none yet queued=0 open fds=n/a");
  });

  it("reports elapsed heartbeat time, queue depth, and fd count", () => {
    expect(
      formatLivenessLine({
        registered: true,
        msSinceLastKeepaliveAck: 12_345,
        queuedCount: 3,
        openFds: 57,
      }),
    ).toBe("daemon liveness: registered=true last keepalive ack=12345ms ago queued=3 open fds=57");
  });
});

describe("startLivenessLog", () => {
  it("logs on the configured interval using the injected state", async () => {
    vi.useFakeTimers();
    const lines: string[] = [];
    let registered = false;
    let lastAck: number | undefined;
    let now = 0;
    const stop = startLivenessLog({
      intervalMs: 1_000,
      isRegistered: () => registered,
      lastKeepaliveAckAtMs: () => lastAck,
      queuedCount: () => 2,
      log: (line) => lines.push(line),
      nowMs: () => now,
      countOpenFds: () => 10,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(lines).toEqual([
      "daemon liveness: registered=false last keepalive ack=none yet queued=2 open fds=10",
    ]);

    registered = true;
    lastAck = 500;
    now = 1_500;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(lines[1]).toBe(
      "daemon liveness: registered=true last keepalive ack=1000ms ago queued=2 open fds=10",
    );

    stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(lines).toHaveLength(2);
  });

  it("calls unref() on the timer it creates, so it never keeps the process alive on its own", () => {
    const unref = vi.fn();
    const fakeTimer = { unref, [Symbol.toPrimitive]: () => 1 } as unknown as NodeJS.Timeout;
    const setIntervalSpy = vi
      .spyOn(globalThis, "setInterval")
      .mockReturnValue(fakeTimer as unknown as ReturnType<typeof setInterval>);
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval").mockImplementation(() => {});
    try {
      const stop = startLivenessLog({
        isRegistered: () => false,
        lastKeepaliveAckAtMs: () => undefined,
        queuedCount: () => 0,
        log: () => undefined,
      });
      expect(unref).toHaveBeenCalledOnce();
      stop();
      expect(clearIntervalSpy).toHaveBeenCalledWith(fakeTimer);
    } finally {
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    }
  });
});
