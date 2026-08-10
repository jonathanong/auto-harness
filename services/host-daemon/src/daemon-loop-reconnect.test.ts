/* eslint-disable max-lines */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { HostToServerMessage, HostWireMessage } from "@auto-harness/shared";

import type { DaemonTransport } from "./daemon-transport-types.ts";
import { DaemonLoop } from "./daemon-loop.ts";
import { createLoopbackTransport } from "./loopback-transport.ts";
import { makeRepo } from "./daemon-loop-test-helpers.ts";

describe("DaemonLoop reconnect", () => {
  it("uses the 75-second reconnect grace by default", () => {
    const loop = new DaemonLoop({
      config: {
        hostId: "h",
        logLevel: "info",
        repositories: [],
        providerAccounts: [],
        commandProfiles: {},
      },
      transport: createLoopbackTransport({ sendToServer() {} }),
    });
    expect((loop as unknown as { reconnectAbortMs: number }).reconnectAbortMs).toBe(75_000);
    loop.stop();
  });

  it("drops an assignment disconnected before its acknowledgement and does not report it", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const transport = new DelayedAckTransport();
      const loop = new DaemonLoop({ config, transport });
      await loop.start();
      transport.deliver({
        type: "session:assign",
        sessionId: "before-ack",
        repositoryId: "demo",
        prompt: "hello",
        resolvedArgv: ["printf", "%s", "hello"],
        timeout: 30,
        worktreeId: "wt-1",
        assignedAt: new Date().toISOString(),
      });
      await Promise.resolve();
      transport.disconnect();
      transport.resolveAck();
      await loop.waitForIdle();
      transport.reconnect();
      await Promise.resolve();

      expect(transport.sent.filter((message) => message.type === "session:status")).toEqual([]);
      expect(transport.sent.filter((message) => message.type === "session:log")).toEqual([]);
      expect(
        transport.sent.filter(
          (message) =>
            message.type === "host:register" && message.runningSessions?.includes("before-ack"),
        ),
      ).toEqual([]);
      loop.stop();
    } finally {
      cleanup();
    }
  });

  it("does not execute when an ACK write succeeds but the peer closes before durable confirmation", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const transport = new EventTransport();
      const loop = new DaemonLoop({ config, transport });
      await loop.start();
      transport.deliver(assignMessage("write-without-server-ack"));
      await settle();
      expect(transport.sent).toContainEqual({
        type: "session:ack",
        sessionId: "write-without-server-ack",
      });

      // `send()` completed, but the peer has not processed the frame. The
      // disconnect must abort unconfirmed work; a late reply cannot revive it.
      transport.disconnect();
      transport.deliver({ type: "session:acknowledged", sessionId: "write-without-server-ack" });
      await loop.waitForIdle();

      expect(transport.sent.filter((message) => message.type === "session:status")).toEqual([]);
      expect(loop.inflightCount()).toBe(0);
      loop.stop();
    } finally {
      cleanup();
    }
  });

  it("runs only after one durable ACK confirmation and ignores duplicate or late replies", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const transport = new EventTransport();
      const loop = new DaemonLoop({ config, transport });
      await loop.start();
      transport.deliver(assignMessage("confirmed-once"));
      await settle();
      expect(transport.sent.some((message) => message.type === "session:ack")).toBe(true);

      transport.deliver({ type: "session:acknowledged", sessionId: "confirmed-once" });
      transport.deliver({ type: "session:acknowledged", sessionId: "confirmed-once" });
      await loop.waitForIdle();
      transport.deliver({ type: "session:acknowledged", sessionId: "confirmed-once" });

      expect(
        transport.sent.filter(
          (message) => message.type === "session:status" && message.sessionId === "confirmed-once",
        ),
      ).toHaveLength(1);
      loop.stop();
    } finally {
      cleanup();
    }
  });

  it("aborts a healthy-but-unconfirmed ACK after the confirmation timeout", async () => {
    const { config, cleanup } = await makeRepo();
    vi.useFakeTimers();
    try {
      const lines: string[] = [];
      const transport = new EventTransport();
      const loop = new DaemonLoop({
        config,
        transport,
        ackConfirmationMs: 5,
        timers: globalThis,
        onLog: (line) => lines.push(line),
      });
      await loop.start();
      transport.deliver(assignMessage("ack-timeout"));
      await settle();
      await vi.advanceTimersByTimeAsync(5);
      await loop.waitForIdle();

      expect(lines).toContain("acknowledgement confirmation timed out for ack-timeout");
      expect(transport.sent.filter((message) => message.type === "session:status")).toEqual([]);
      loop.stop();
    } finally {
      cleanup();
    }
  });

  it("refreshes inventory, keeps alive, and exposes draining state", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const sent: HostToServerMessage[] = [];
      const transport = createLoopbackTransport({
        sendToServer: (message) => void sent.push(message),
      });
      const loop = new DaemonLoop({ config, transport, now: () => "now", isDraining: () => false });
      await loop.start();
      await loop.applyInventory({ ...config, commandProfiles: { changed: { argv: ["echo"] } } });
      await loop.keepalive();
      expect(sent.filter((message) => message.type === "host:register")).toHaveLength(2);
      expect(sent.at(-1)).toEqual({ type: "host:keepalive", hostId: config.hostId, at: "now" });
      expect(loop.isDraining()).toBe(false);
      loop.beginDrain();
      expect(loop.isDraining()).toBe(true);
      await loop.waitForIdle();
      loop.stop();
    } finally {
      cleanup();
    }
  });

  it("refreshes reconnect and inventory registration snapshots ahead of held outbound traffic", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const transport = new BarrierTransport();
      const loop = new DaemonLoop({ config, transport });
      await loop.start();
      const inflight = (
        loop as unknown as {
          inflight: Map<string, { acknowledged: boolean }>;
          outbound: { send(message: HostToServerMessage): Promise<void> };
        }
      ).inflight;
      const outbound = (
        loop as unknown as {
          outbound: { send(message: HostToServerMessage): Promise<void> };
        }
      ).outbound;
      inflight.set("late-ack", {
        controller: new AbortController(),
        work: Promise.resolve(),
        acknowledged: false,
      });
      const stale = loop.register();
      await stale;
      expect(transport.registers.at(-1)?.runningSessions).toEqual([]);

      const heldLog = outbound.send({
        type: "session:log",
        sessionId: "late-ack",
        stream: "stdout",
        content: "offline backlog",
        timestamp: "2026-01-01T00:00:00.000Z",
        seq: 1,
      });
      await settle();
      expect(transport.heldLog).toBe(true);
      inflight.get("late-ack")!.acknowledged = true;

      transport.connect();
      await settle();
      expect(transport.registers.at(-1)).toEqual(
        expect.objectContaining({ runningSessions: ["late-ack"] }),
      );
      expect(transport.sent.at(-1)?.type).toBe("host:register");

      await loop.applyInventory({
        ...config,
        commandProfiles: { ...config.commandProfiles, refreshed: { argv: ["echo"] } },
      });
      expect(transport.registers.at(-1)).toEqual(
        expect.objectContaining({ commandProfiles: ["echo-prompt", "refreshed"] }),
      );
      expect(transport.sent.at(-1)?.type).toBe("host:register");

      transport.releaseLog();
      await expect(heldLog).resolves.toBeUndefined();
      const heldLogIndex = transport.sent.findIndex(
        (message) => message.type === "session:log" && message.content === "offline backlog",
      );
      const refreshedRegisterIndex = transport.sent.findLastIndex(
        (message) => message.type === "host:register",
      );
      expect(heldLogIndex).toBeGreaterThanOrEqual(0);
      expect(refreshedRegisterIndex).toBeLessThan(heldLogIndex);
      loop.stop();
    } finally {
      cleanup();
    }
  });

  it("refuses assignments beyond the bounded critical-producer session capacity", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const lines: string[] = [];
      const sent: HostToServerMessage[] = [];
      const loop = new DaemonLoop({
        config,
        transport: createLoopbackTransport({ sendToServer: (message) => void sent.push(message) }),
        onLog: (line) => lines.push(line),
      });
      const inflight = (loop as unknown as { inflight: Map<string, unknown> }).inflight;
      for (let index = 0; index < 64; index++) {
        inflight.set(`active-${index}`, {
          controller: new AbortController(),
          work: Promise.resolve(),
          acknowledged: true,
        });
      }
      await (
        loop as unknown as {
          handleServerMessage(message: HostWireMessage): Promise<void>;
        }
      ).handleServerMessage({
        type: "session:assign",
        sessionId: "over-capacity",
        repositoryId: "demo",
        prompt: "hello",
        resolvedArgv: ["printf", "%s", "hello"],
        timeout: 30,
        worktreeId: "wt-1",
        assignedAt: new Date().toISOString(),
      });
      expect(loop.inflightCount()).toBe(64);
      expect(sent).toEqual([]);
      expect(lines).toContain("session capacity reached: refused assign over-capacity");
    } finally {
      cleanup();
    }
  });

  it("aborts acknowledged in-flight work after the reconnect grace and omits unacked work from registration", async () => {
    vi.useFakeTimers();
    const { config, cleanup } = await makeRepo();
    try {
      const transport = new EventTransport();
      const loop = new DaemonLoop({ config, transport, reconnectAbortMs: 5, timers: globalThis });
      await loop.start();
      const acknowledged = new AbortController();
      const unacknowledged = new AbortController();
      const inflight = (loop as unknown as { inflight: Map<string, unknown> }).inflight;
      inflight.set("ack", {
        controller: acknowledged,
        work: Promise.resolve(),
        acknowledged: true,
      });
      inflight.set("no-ack", {
        controller: unacknowledged,
        work: Promise.resolve(),
        acknowledged: false,
      });
      await loop.register();
      expect(transport.sent.at(-1)).toEqual(expect.objectContaining({ runningSessions: ["ack"] }));
      transport.disconnect();
      expect(unacknowledged.signal.aborted).toBe(true);
      await vi.advanceTimersByTimeAsync(5);
      expect(acknowledged.signal.aborted).toBe(true);
      loop.stop();
    } finally {
      cleanup();
    }
  });

  it("reports a failed reconnect registration through the loop logger", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const transport = new EventTransport();
      const lines: string[] = [];
      const loop = new DaemonLoop({ config, transport, onLog: (line) => lines.push(line) });
      await loop.start();
      transport.failSends = true;
      transport.connect();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(lines.some((line) => line.includes("re-register failed"))).toBe(true);
      loop.stop();
    } finally {
      cleanup();
    }
  });
});

afterEach(() => vi.useRealTimers());

class DelayedAckTransport implements DaemonTransport {
  readonly sent: HostToServerMessage[] = [];
  private handler: ((message: HostWireMessage) => void) | undefined;
  private connected: (() => void) | undefined;
  private disconnected: (() => void) | undefined;
  private releaseAck: (() => void) | undefined;

  async send(message: HostToServerMessage): Promise<void> {
    this.sent.push(message);
    if (message.type !== "session:ack") return;
    await new Promise<void>((resolve) => {
      this.releaseAck = resolve;
    });
  }

  onMessage(handler: (message: HostWireMessage) => void): void {
    this.handler = handler;
  }

  onConnected(handler: () => void): void {
    this.connected = handler;
  }

  onDisconnected(handler: () => void): void {
    this.disconnected = handler;
  }

  close(): void {}

  deliver(message: HostWireMessage): void {
    this.handler?.(message);
  }

  disconnect(): void {
    this.disconnected?.();
  }

  reconnect(): void {
    this.connected?.();
  }

  resolveAck(): void {
    this.releaseAck?.();
  }
}

class EventTransport implements DaemonTransport {
  readonly sent: HostToServerMessage[] = [];
  failSends = false;
  private message: ((message: HostWireMessage) => void) | undefined;
  private connected: (() => void) | undefined;
  private disconnected: (() => void) | undefined;

  async send(message: HostToServerMessage): Promise<void> {
    if (this.failSends) throw new Error("offline");
    this.sent.push(message);
  }
  onMessage(handler: (message: HostWireMessage) => void): void {
    this.message = handler;
  }
  onDisconnected(handler: () => void): void {
    this.disconnected = handler;
  }
  onConnected(handler: () => void): void {
    this.connected = handler;
  }
  close(): void {
    this.message = undefined;
  }
  disconnect(): void {
    this.disconnected?.();
  }
  connect(): void {
    this.connected?.();
  }
  deliver(message: HostWireMessage): void {
    this.message?.(message);
  }
}

class BarrierTransport implements DaemonTransport {
  readonly sent: HostToServerMessage[] = [];
  readonly registers: Array<Extract<HostToServerMessage, { type: "host:register" }>> = [];
  heldLog = false;
  private connected: (() => void) | undefined;
  private release: (() => void) | undefined;

  send(message: HostToServerMessage): Promise<void> {
    if (message.type === "host:register") {
      this.sent.push(message);
      this.registers.push(message);
      return Promise.resolve();
    }
    if (message.type !== "session:log") {
      this.sent.push(message);
      return Promise.resolve();
    }
    this.heldLog = true;
    return new Promise<void>((resolve) => {
      this.release = () => {
        this.sent.push(message);
        resolve();
      };
    });
  }

  onMessage(): void {}
  onDisconnected(): void {}
  onConnected(handler: () => void): void {
    this.connected = handler;
  }
  close(): void {}
  connect(): void {
    this.connected?.();
  }
  releaseLog(): void {
    this.release?.();
  }
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function assignMessage(sessionId: string): Extract<HostWireMessage, { type: "session:assign" }> {
  return {
    type: "session:assign",
    sessionId,
    repositoryId: "demo",
    prompt: "hello",
    resolvedArgv: ["printf", "%s", "hello"],
    timeout: 30,
    worktreeId: "wt-1",
    assignedAt: new Date().toISOString(),
  };
}
