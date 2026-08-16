import { describe, expect, it } from "vitest";

import { DaemonLoop, createLoopbackTransport } from "./daemon-loop.ts";
import { makeRepo } from "./daemon-loop-test-helpers.ts";

/**
 * beginDrain() resolved only on a host:drain / host:draining message or a reconnect
 * registration, and scheduleDrainRetry kept re-announcing every second. With the control
 * plane unreachable neither ever happened, so stop() never settled — even with nothing in
 * flight — and TimeoutStopSec=infinity meant systemctl stop hung with it.
 */
describe("DaemonLoop drain deadline", () => {
  it("gives up announcing when the control plane never acknowledges", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const logs: string[] = [];
      let reachable = true;
      const transport = createLoopbackTransport({
        sendToServer: () => {
          if (!reachable) throw new Error("control plane unreachable");
        },
      });
      const loop = new DaemonLoop({
        config,
        transport,
        onLog: (line) => logs.push(line),
        drainRetryMs: 10,
        drainDeadlineMs: 50,
      });
      await loop.start();
      reachable = false;

      await expect(loop.beginDrain()).resolves.toBeUndefined();

      expect(loop.isDraining()).toBe(true);
      expect(logs.some((line) => line.includes("not acknowledged"))).toBe(true);
      loop.stop();
    } finally {
      await cleanup();
    }
  });

  it("prefers a real acknowledgement over the deadline", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const logs: string[] = [];
      const transport = createLoopbackTransport({ sendToServer: () => undefined });
      const loop = new DaemonLoop({
        config,
        transport,
        onLog: (line) => logs.push(line),
        drainDeadlineMs: 60_000,
      });
      await loop.start();

      const draining = loop.beginDrain();
      transport.deliver({ type: "host:draining", hostId: config.hostId });
      await draining;

      expect(logs.some((line) => line.includes("not acknowledged"))).toBe(false);
      loop.stop();
    } finally {
      await cleanup();
    }
  });
});
