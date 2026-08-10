/* eslint-disable max-lines */
import { describe, expect, it } from "vitest";

import type { HostToServerMessage } from "@auto-harness/shared";

import { OutboundQueue } from "./outbound-queue.ts";

const keepalive = (at: string): HostToServerMessage => ({
  type: "host:keepalive",
  hostId: "h",
  at,
});

describe("OutboundQueue", () => {
  it("rejects the failed caller but recovers FIFO delivery for the next caller", async () => {
    const sent: string[] = [];
    const reports: string[] = [];
    let fail = true;
    const queue = new OutboundQueue(
      {
        async send(message) {
          if (fail) {
            fail = false;
            throw new Error("offline");
          }
          sent.push(message.type);
        },
        onMessage() {},
        close() {},
      },
      (line) => reports.push(line),
    );

    await expect(queue.send(keepalive("first"))).rejects.toThrow("offline");
    await expect(queue.send(keepalive("second"))).resolves.toBeUndefined();
    await queue.flush();
    expect(sent).toEqual(["host:keepalive"]);
    expect(reports[0]).toContain("offline");
  });

  it("reports non-Error failures while preserving the rejecting delivery", async () => {
    const reports: string[] = [];
    const queue = new OutboundQueue(
      {
        async send() {
          throw "raw";
        },
        onMessage() {},
        close() {},
      },
      (line) => reports.push(line),
    );
    await expect(queue.send(keepalive("raw"))).rejects.toBe("raw");
    expect(reports).toEqual(["outbound host:keepalive failed: raw"]);
  });

  it("coalesces pending keepalives to the latest state", async () => {
    const transport = new HeldTransport();
    const queue = new OutboundQueue(transport, () => {});
    const first = queue.send(keepalive("first"));
    const second = queue.send(keepalive("second"));
    await settle();
    expect(transport.sent).toEqual([keepalive("second")]);
    transport.release();
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
  });

  it("coalesces a queued registration and flushes the serialized snapshot", async () => {
    const transport = new HeldTransport();
    const queue = new OutboundQueue(transport, () => {});
    const ack = queue.send({ type: "session:ack", sessionId: "before-register" });
    const old = queue.send(register(["old"]));
    const latest = queue.send(register(["latest"]));
    const flushed = queue.flush();
    await settle();
    expect(transport.sent).toEqual([{ type: "session:ack", sessionId: "before-register" }]);
    transport.release();
    await settle();
    expect(transport.sent.at(-1)).toEqual(register(["latest"]));
    transport.release();
    await expect(Promise.all([ack, old, latest, flushed])).resolves.toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("bounds more than one thousand critical producers without losing their FIFO delivery", async () => {
    const transport = new HeldTransport();
    const reports: string[] = [];
    const queue = new OutboundQueue(transport, (line) => reports.push(line));
    const deliveries = Array.from({ length: 1_002 }, (_, index) =>
      queue.send({ type: "session:ack", sessionId: `s${index}` }),
    );
    // Queue-owned storage is capped: the final critical producer is waiting
    // on the shared capacity signal, not retained as a 1,001st item/callback.
    expect(queue.length).toBe(1_000);
    await settle();
    for (let index = 0; index < 1_000; index++) {
      expect(transport.sent.at(-1)).toEqual({ type: "session:ack", sessionId: `s${index}` });
      transport.release();
      await settle();
      expect(queue.length).toBeLessThanOrEqual(1_000);
    }
    expect(queue.length).toBe(2);
    expect(transport.sent.at(-1)).toEqual({ type: "session:ack", sessionId: "s1000" });
    transport.release();
    await settle();
    expect(queue.length).toBe(1);
    expect(transport.sent.at(-1)).toEqual({ type: "session:ack", sessionId: "s1001" });
    transport.release();
    await expect(Promise.all(deliveries)).resolves.toHaveLength(1_002);
    expect(reports).toEqual([]);
  });

  it("immediately cancels an admission waiting before an acknowledgement can be sent", async () => {
    const transport = new HeldTransport();
    const queue = new OutboundQueue(transport, () => {});
    const admitted = Array.from({ length: 1_000 }, (_, index) =>
      queue.send({ type: "session:ack", sessionId: `s${index}` }),
    );
    const head = new AbortController();
    const blocked = queue.send({ type: "session:ack", sessionId: "head" }, { signal: head.signal });
    const controller = new AbortController();
    const cancelled = queue.send(
      { type: "session:ack", sessionId: "cancelled-before-ack" },
      { signal: controller.signal },
    );
    controller.abort();
    await expect(cancelled).rejects.toThrow("cancelled");
    expect(queue.length).toBe(1_000);
    transport.release();
    await settle();
    expect(queue.length).toBe(1_000);
    expect((queue as unknown as { criticalTurn: number }).criticalTurn).toBe(1_002);
    for (const delivery of admitted) void delivery.catch(() => {});
    void blocked.catch(() => {});
  });

  it("coalesces one overflow burst into a single retained recovery marker", async () => {
    const transport = new HeldTransport();
    const queue = new OutboundQueue(transport, () => {});
    const logs = Array.from({ length: 1_001 }, (_, seq) => queue.send(log(seq)));
    for (const delivery of logs) void delivery.catch(() => {});
    expect(queue.length).toBeLessThanOrEqual(1_000);
    await expect(logs.at(-1)).rejects.toThrow("outbound buffer full");
    await settle();
    while (queue.length > 0 || transport.pendingWrites > 0) {
      transport.release();
      await settle();
    }
    await settleMany();
    while (queue.length > 0 || transport.pendingWrites > 0) {
      transport.release();
      await settle();
    }
    const markers = transport.sent.filter(
      (message) =>
        message.type === "session:log" &&
        message.stream === "system" &&
        message.content.includes("dropped while disconnected"),
    );
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ content: "2 log chunk(s) dropped while disconnected" });
  });

  it("rejects oversized frames and skips a cancelled critical producer", async () => {
    const transport = new HeldTransport();
    const queue = new OutboundQueue(transport, () => {});
    await expect(queue.send(log(1, "x".repeat(4 * 1024 * 1024 + 1)))).rejects.toThrow("exceeds");
    await settle();
    transport.release();
    await settle();
    const controller = new AbortController();
    controller.abort();
    await expect(
      queue.send(
        { type: "session:status", sessionId: "cancelled", status: "failed" },
        {
          signal: controller.signal,
        },
      ),
    ).rejects.toThrow("cancelled");
    await expect(
      queue.send({
        type: "session:status",
        sessionId: "large",
        status: "failed",
        errorMessage: "x".repeat(4 * 1024 * 1024 + 1),
      }),
    ).rejects.toThrow("exceeds");
    void queue.send({ type: "session:ack", sessionId: "block-registration" });
    void queue.send(register(["old"]));
    await expect(queue.send(register(["x".repeat(4 * 1024 * 1024 + 1)]))).rejects.toThrow(
      "exceeds",
    );
  });

  it("ignores a late completion after a serialized write has already settled", async () => {
    const transport = new HeldTransport();
    const queue = new OutboundQueue(transport, () => {});
    const delivery = queue.send(keepalive("once"));
    await settle();
    const item = (queue as unknown as { inflight: unknown }).inflight;
    transport.release();
    await expect(delivery).resolves.toBeUndefined();
    (queue as unknown as { settle(item: unknown): void }).settle(item);
    expect(queue.length).toBe(0);
  });
});

class HeldTransport {
  readonly sent: HostToServerMessage[] = [];
  private readonly releases: Array<() => void> = [];

  send(message: HostToServerMessage): Promise<void> {
    this.sent.push(message);
    return new Promise<void>((resolve) => this.releases.push(resolve));
  }

  onMessage(): void {}

  close(): void {}

  release(): void {
    this.releases.shift()?.();
  }

  get pendingWrites(): number {
    return this.releases.length;
  }
}

function log(seq: number, content = "log"): HostToServerMessage {
  return {
    type: "session:log",
    sessionId: "s",
    stream: "stdout",
    content,
    timestamp: "2026-01-01T00:00:00.000Z",
    seq,
  };
}

function register(commandProfiles: string[]): HostToServerMessage {
  return { type: "host:register", hostId: "h", worktrees: [], commandProfiles };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function settleMany(): Promise<void> {
  for (let index = 0; index < 10; index++) await Promise.resolve();
}
