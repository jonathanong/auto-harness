/* eslint-disable max-lines */
import { describe, expect, it } from "vitest";

import { WsOutboundBuffer } from "./ws-outbound-buffer.ts";

const log = (seq: number) => ({
  type: "session:log" as const,
  sessionId: "s1",
  stream: "stdout" as const,
  content: "x",
  timestamp: "2026-01-01T00:00:00.000Z",
  seq,
});

describe("WsOutboundBuffer", () => {
  it("keeps control transitions by evicting only droppable logs", async () => {
    const dropped: string[] = [];
    const buffer = new WsOutboundBuffer((message) => dropped.push(message.sessionId));
    const deliveries = Array.from({ length: 1_000 }, (_, seq) => buffer.enqueue(log(seq)));
    for (const delivery of deliveries) void delivery.catch(() => {});

    void buffer.enqueue({ type: "session:ack", sessionId: "s1" });
    expect(dropped).toEqual(["s1"]);
    expect(buffer.length).toBe(1_000);
    expect(buffer.take()?.message.type).toBe("session:log");
    expect(buffer.take()?.message.type).toBe("session:log");
    for (let index = 0; index < 997; index++) buffer.take();
    expect(buffer.take()?.message.type).toBe("session:ack");
  });

  it("rejects a new log when the bounded queue has no room", async () => {
    const buffer = new WsOutboundBuffer();
    const deliveries = Array.from({ length: 1_000 }, (_, seq) => buffer.enqueue(log(seq)));
    for (const delivery of deliveries) void delivery.catch(() => {});
    await expect(buffer.enqueue(log(1_001))).rejects.toThrow("outbound buffer full");
  });

  it("enforces the byte limit while retaining a critical transition", async () => {
    const dropped: number[] = [];
    const buffer = new WsOutboundBuffer((message) => dropped.push(message.seq));
    const first = buffer.enqueue({ ...log(1), content: "x".repeat(3_000_000) });
    const second = buffer.enqueue({ ...log(2), content: "x".repeat(2_000_000) });
    void first.catch(() => {});
    void second.catch(() => {});
    void buffer.enqueue({
      type: "session:status",
      sessionId: "s1",
      status: "failed",
      errorMessage: "x".repeat(2_000_000),
    });
    expect(dropped).toEqual([2, 1]);
    expect(buffer.take()?.message.type).toBe("session:status");
  });

  it("backpressures critical frames at the count cap without requeueing 1001", async () => {
    const buffer = new WsOutboundBuffer();
    const controls = Array.from({ length: 1_002 }, (_, index) =>
      buffer.enqueue({ type: "session:ack", sessionId: `s${index}` }),
    );
    expect(buffer.length).toBe(1_000);
    const inflight = buffer.take();
    expect(inflight).toBeDefined();
    if (!inflight) throw new Error("expected inflight control frame");
    expect(inflight.message).toMatchObject({ sessionId: "s0" });
    // A failed write keeps the frame inside the same bounded reservation, so
    // the delayed producer cannot make the buffer grow to 1,001.
    buffer.putBack(inflight);
    expect(buffer.length).toBe(1_000);
    const retried = buffer.take();
    expect(retried?.message).toMatchObject({ sessionId: "s0" });
    if (!retried) throw new Error("expected retried control frame");
    buffer.complete(retried);
    retried.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(buffer.length).toBe(1_000);
    for (let index = 1; index < 1_000; index++) {
      const item = buffer.take();
      expect(item?.message).toMatchObject({ sessionId: `s${index}` });
      if (!item) throw new Error("expected queued control frame");
      buffer.complete(item);
      item.resolve();
    }
    await Promise.resolve();
    await Promise.resolve();
    expect(buffer.length).toBe(2);
    const firstDelayed = buffer.take();
    expect(firstDelayed?.message).toMatchObject({ sessionId: "s1000" });
    if (!firstDelayed) throw new Error("expected first delayed control frame");
    buffer.complete(firstDelayed);
    firstDelayed.resolve();
    const secondDelayed = buffer.take();
    expect(secondDelayed?.message).toMatchObject({ sessionId: "s1001" });
    if (!secondDelayed) throw new Error("expected second delayed control frame");
    buffer.complete(secondDelayed);
    secondDelayed.resolve();
    await expect(Promise.all(controls.slice(-2))).resolves.toEqual([undefined, undefined]);
  });

  it("backpressures retained frames at the byte cap until an in-flight write settles", async () => {
    const buffer = new WsOutboundBuffer();
    const first = buffer.enqueue({
      type: "session:status",
      sessionId: "first",
      status: "failed",
      errorMessage: "x".repeat(3_000_000),
    });
    const delayed = buffer.enqueue({
      type: "session:status",
      sessionId: "second",
      status: "failed",
      errorMessage: "x".repeat(2_000_000),
    });
    expect(buffer.length).toBe(1);
    const inflight = buffer.take();
    if (!inflight) throw new Error("expected first status");
    buffer.complete(inflight);
    inflight.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(buffer.length).toBe(1);
    const admitted = buffer.take();
    expect(admitted?.message).toMatchObject({ sessionId: "second" });
    if (!admitted) throw new Error("expected delayed status");
    buffer.complete(admitted);
    admitted.resolve();
    await expect(first).resolves.toBeUndefined();
    await expect(delayed).resolves.toBeUndefined();
  });

  it("drops oversized logs and supports abort, put-back, and terminal rejection", async () => {
    const dropped: number[] = [];
    const buffer = new WsOutboundBuffer((message) => dropped.push(message.seq));
    await expect(
      buffer.enqueue({ ...log(1), content: "x".repeat(4 * 1024 * 1024 + 1) }),
    ).rejects.toThrow("exceeds");
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await expect(buffer.enqueue(log(2), { signal: alreadyAborted.signal })).rejects.toThrow(
      "cancelled",
    );
    const controller = new AbortController();
    const queued = buffer.enqueue(log(3), { signal: controller.signal });
    controller.abort();
    await expect(queued).rejects.toThrow("cancelled");
    const signalled = new AbortController();
    const signalledDelivery = buffer.enqueue(
      { type: "session:status", sessionId: "signalled", status: "completed" },
      { signal: signalled.signal },
    );
    const signalledItem = buffer.take();
    if (!signalledItem) throw new Error("expected signalled status");
    signalledItem.dispose();
    expect(signalledItem.cancelled()).toBe(false);
    signalled.abort();
    expect(signalledItem.cancelled()).toBe(true);
    buffer.complete(signalledItem);
    signalledItem.resolve();
    await expect(signalledDelivery).resolves.toBeUndefined();
    const retainedAbort = new AbortController();
    retainedAbort.abort();
    await expect(
      buffer.enqueue(
        { type: "session:status", sessionId: "aborted", status: "failed" },
        { signal: retainedAbort.signal },
      ),
    ).rejects.toThrow("cancelled");
    await expect(
      buffer.enqueue({
        type: "session:status",
        sessionId: "oversized",
        status: "failed",
        errorMessage: "x".repeat(4 * 1024 * 1024 + 1),
      }),
    ).rejects.toThrow("exceeds");
    const retained = buffer.enqueue({
      type: "session:status",
      sessionId: "s1",
      status: "completed",
    });
    const item = buffer.take();
    expect(buffer.take()).toBeUndefined();
    if (!item) throw new Error("expected queued status");
    expect(item.cancelled()).toBe(false);
    buffer.putBack(item);
    const replayed = buffer.take();
    if (!replayed) throw new Error("expected requeued status");
    buffer.complete(replayed);
    buffer.complete(replayed);
    replayed.resolve();
    replayed.resolve();
    await expect(retained).resolves.toBeUndefined();
    const closing = buffer.enqueue({ type: "session:ack", sessionId: "closing" });
    const closingItem = buffer.take();
    expect(closingItem).toBeDefined();
    buffer.rejectAll(new Error("closed"));
    closingItem?.reject(new Error("late close"));
    expect(buffer.length).toBe(0);
    await expect(closing).rejects.toThrow("closed");
    await expect(buffer.enqueue({ type: "session:ack", sessionId: "after-close" })).rejects.toThrow(
      "closed",
    );
    expect(dropped).toEqual([1]);
  });

  it("rejects a waiting critical producer when the transport closes", async () => {
    const buffer = new WsOutboundBuffer();
    const controls = Array.from({ length: 1_000 }, (_, index) =>
      buffer.enqueue({ type: "session:ack", sessionId: `s${index}` }),
    );
    for (const delivery of controls) void delivery.catch(() => {});
    const waiting = buffer.enqueue({
      type: "session:status",
      sessionId: "waiting",
      status: "failed",
    });
    buffer.rejectAll(new Error("closed"));
    await expect(waiting).rejects.toThrow("closed");
  });
});
