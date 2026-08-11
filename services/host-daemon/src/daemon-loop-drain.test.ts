import { describe, expect, it, vi } from "vitest";

import { DaemonLoop, createLoopbackTransport } from "./daemon-loop.ts";
import { makeRepo } from "./daemon-loop-test-helpers.ts";

describe("DaemonLoop drain", () => {
  it("drain refuses new assigns without killing inflight tracking", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const logs: string[] = [];
      const transport = createLoopbackTransport({
        sendToServer: () => {
          /* ignore */
        },
      });
      const loop = new DaemonLoop({
        config,
        transport,
        onLog: (l) => {
          logs.push(l);
        },
        isDraining: () => false,
      });
      await loop.start();
      const draining = loop.beginDrain();
      expect(loop.isDraining()).toBe(false);
      transport.deliver({ type: "host:draining", hostId: config.hostId });
      await draining;
      expect(loop.isDraining()).toBe(true);
      transport.deliver({
        type: "session:assign",
        sessionId: "sess-x",
        repositoryId: "demo",
        prompt: "x",
        resolvedArgv: ["printf", "%s", "x"],
        timeout: 10,
        worktreeId: "wt-1",
        assignedAt: new Date().toISOString(),
      });
      await loop.waitForIdle();
      expect(loop.inflightCount()).toBe(0);
      expect(logs.some((l) => l.includes("draining"))).toBe(true);
      transport.deliver({ type: "session:cancel", sessionId: "sess-x" });
      expect(logs.some((l) => l.includes("cancel"))).toBe(true);
      // unknown wire type ignored
      transport.deliver({ type: "ping" } as never);
      loop.stop();

      // external isDraining predicate
      const transport3 = createLoopbackTransport({ sendToServer: () => undefined });
      let drainFlag = false;
      const loop3 = new DaemonLoop({
        config,
        transport: transport3,
        isDraining: () => drainFlag,
      });
      await loop3.start();
      expect(loop3.isDraining()).toBe(false);
      drainFlag = true;
      expect(loop3.isDraining()).toBe(true);
      loop3.stop();
    } finally {
      cleanup();
    }
  });

  it("keeps a reconnect registration draining until the durable acknowledgement arrives", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const sent: Array<{ type: string; draining?: boolean }> = [];
      const transport = createLoopbackTransport({
        sendToServer: (message) => void sent.push(message),
      });
      const loop = new DaemonLoop({ config, transport });
      await loop.start();

      const draining = loop.beginDrain();
      await Promise.resolve();
      expect(sent.at(-1)).toMatchObject({ type: "host:status", draining: true });
      await loop.register();
      expect(sent.at(-1)).toMatchObject({ type: "host:register", draining: true });
      expect(loop.isDraining()).toBe(false);

      transport.deliver({ type: "host:drain" });
      await draining;
      expect(loop.isDraining()).toBe(true);
      loop.stop();
    } finally {
      cleanup();
    }
  });

  it("retries a failed or unacknowledged drain notification without exiting", async () => {
    vi.useFakeTimers();
    const { config, cleanup } = await makeRepo();
    try {
      const sent: Array<{ type: string }> = [];
      let firstDrain = true;
      let drainAttempts = 0;
      const transport = createLoopbackTransport({
        sendToServer: (message) => {
          if (message.type === "host:status") {
            drainAttempts++;
            if (firstDrain) {
              firstDrain = false;
              throw new Error("connection lost");
            }
          }
          sent.push(message);
        },
      });
      const loop = new DaemonLoop({ config, transport, drainRetryMs: 1, timers: globalThis });
      await loop.start();

      const draining = loop.beginDrain();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1);
      expect(drainAttempts).toBe(2);
      expect(sent.filter((message) => message.type === "host:status")).toHaveLength(1);
      expect(loop.isDraining()).toBe(false);

      transport.deliver({ type: "host:draining", hostId: config.hostId });
      await draining;
      await vi.advanceTimersByTimeAsync(10);
      expect(drainAttempts).toBe(2);
      loop.stop();
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });
});
