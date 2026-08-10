/* eslint-disable max-lines */
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import { FakeSocket, transportFor } from "./ws-transport-test-helpers.ts";

afterEach(() => vi.useRealTimers());
describe("reconnecting WebSocket transport", () => {
  it("coalesces delayed-open registration to the latest snapshot", async () => {
    const sockets: FakeSocket[] = [];
    const transport = transportFor(sockets);
    const first = sockets[0]!;
    await transport.send(register(["old"]));
    await transport.send(register(["latest"]));
    first.open();
    await settle();
    expect(first.sent).toEqual([register(["latest"])]);
    first.server(registered());
    await transport.registered;
    await settle();
    expect(first.sent).toHaveLength(1);
    transport.close();
  });

  it("restarts an in-flight registration before opening a newer inventory barrier", async () => {
    const sockets: FakeSocket[] = [];
    const transport = transportFor(sockets);
    const first = sockets[0]!;
    const assigned: string[] = [];
    transport.onMessage((message) => {
      if (message.type === "session:assign") assigned.push(message.sessionId);
    });
    first.open();
    first.delayNext = true;
    await transport.send(register(["old"]));
    await transport.send(register(["latest"]));
    expect(sockets).toHaveLength(2);
    first.server(registered());
    first.server(assign("stale"));
    const second = sockets[1]!;
    second.open();
    await settle();
    expect(second.sent).toEqual([register(["latest"])]);
    second.server(registered());
    second.server(assign("fresh"));
    await settle();
    expect(assigned).toEqual(["fresh"]);
    transport.close();
  });

  it("backs off 1/2/4 through a 60-second cap and ignores stale epochs", async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const transport = transportFor(sockets);
    await transport.send(register());
    const waits = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000];
    for (const wait of waits) {
      const current = sockets.at(-1)!;
      current.close();
      await vi.advanceTimersByTimeAsync(wait - 1);
      expect(sockets).toHaveLength(waits.indexOf(wait) + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(sockets).toHaveLength(waits.indexOf(wait) + 2);
      current.open();
      await settle();
      expect(current.sent).toEqual([]);
    }
    const latest = sockets.at(-1)!;
    latest.open();
    await settle();
    expect(latest.sent).toEqual([register()]);
    transport.close();
  });

  it("preserves FIFO when a log write is delayed", async () => {
    const sockets: FakeSocket[] = [];
    const transport = transportFor(sockets);
    const socket = sockets[0]!;
    socket.open();
    await transport.send(register());
    socket.server(registered());
    await transport.registered;
    socket.delayNext = true;
    void transport.send(log(1));
    void transport.send(status());
    await settle();
    expect(socket.sent.map((message) => message.type)).toEqual(["host:register", "session:log"]);
    socket.finishWrite();
    await settle();
    expect(socket.sent.map((message) => message.type)).toEqual([
      "host:register",
      "session:log",
      "session:status",
    ]);
    transport.close();
  });

  it("retains critical frames and emits one recovery marker for dropped logs", async () => {
    const sockets: FakeSocket[] = [];
    const transport = transportFor(sockets);
    const deliveries = Array.from({ length: 1_000 }, (_, seq) => transport.send(log(seq)));
    for (const delivery of deliveries) void delivery.catch(() => {});
    void transport.send({ type: "session:ack", sessionId: "s1" });
    const socket = sockets[0]!;
    socket.open();
    await transport.send(register());
    socket.server(registered());
    await transport.registered;
    await settleMany();
    const messages = socket.sent;
    expect(messages.filter((message) => message.type === "session:ack")).toHaveLength(1);
    expect(
      messages.filter(
        (message) =>
          message.type === "session:log" &&
          message.stream === "system" &&
          String(message.content).includes("dropped while disconnected"),
      ),
    ).toHaveLength(1);
    transport.close();
  });

  it("pumps a retained frame admitted after the prior full buffer drains", async () => {
    const sockets: FakeSocket[] = [];
    const transport = transportFor(sockets);
    const socket = sockets[0]!;
    socket.open();
    await transport.send(register());
    socket.server(registered());
    await transport.registered;

    socket.delayNext = true;
    const admitted = Array.from({ length: 1_000 }, (_, index) =>
      transport.send({ type: "session:ack", sessionId: `s${index}` }),
    );
    const parked = transport.send({
      type: "session:status",
      sessionId: "parked",
      status: "failed",
    });
    await settle();
    socket.finishWrite();
    await settleMany();

    expect(socket.sent.at(-1)).toMatchObject({ type: "session:status", sessionId: "parked" });
    await expect(Promise.all([...admitted, parked])).resolves.toHaveLength(1_001);
    transport.close();
  });

  it.each(["callback", "throw"] as const)(
    "recovers %s write failures without losing status",
    async (kind) => {
      vi.useFakeTimers();
      const sockets: FakeSocket[] = [];
      const transport = transportFor(sockets);
      const first = sockets[0]!;
      first.open();
      await transport.send(register());
      first.server(registered());
      await transport.registered;
      if (kind === "callback") first.failNext = new Error("callback write failed");
      else first.throwNext = true;
      void transport.send(status());
      await settle();
      expect(first.readyState).toBe(WebSocket.CLOSED);
      await vi.advanceTimersByTimeAsync(1_000);
      const second = sockets[1]!;
      second.open();
      await settle();
      second.server(registered());
      await settle();
      expect(second.sent.map((message) => message.type)).toEqual([
        "host:register",
        "session:status",
      ]);
      transport.close();
    },
  );

  it("does not reconnect or notify disconnect for an intentional close", () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    let disconnected = 0;
    const transport = transportFor(sockets);
    transport.onDisconnected?.(() => disconnected++);
    void transport.ready.catch(() => {});
    transport.close();
    vi.advanceTimersByTime(60_000);
    expect(disconnected).toBe(0);
    expect(sockets).toHaveLength(1);
  });

  it("rejects registration readiness when the transport is terminally closed", async () => {
    const sockets: FakeSocket[] = [];
    const transport = transportFor(sockets);
    const registeredPromise = transport.registered;
    transport.close();
    await expect(registeredPromise).rejects.toThrow("WebSocket transport closed");
  });

  it("does not replay an aborted acknowledgement across a registration barrier", async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const transport = transportFor(sockets);
    const first = sockets[0]!;
    first.open();
    await transport.send(register());
    first.server(registered());
    await transport.registered;
    const controller = new AbortController();
    first.delayNext = true;
    const ack = transport.send(
      { type: "session:ack", sessionId: "aborted" },
      { signal: controller.signal },
    );
    void ack.catch(() => {});
    await settle();
    controller.abort();
    first.close();
    await vi.advanceTimersByTimeAsync(1_000);
    const second = sockets[1]!;
    second.open();
    await settle();
    second.server(registered());
    await expect(ack).rejects.toThrow("cancelled");
    expect(second.sent.map((message) => message.type)).toEqual(["host:register"]);
    transport.close();
  });

  it("requeues an in-flight status when its callback arrives after close", async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const transport = transportFor(sockets);
    const first = sockets[0]!;
    first.open();
    await transport.send(register());
    first.server(registered());
    await transport.registered;
    first.delayNext = true;
    void transport.send(status());
    await settle();
    first.close();
    await vi.advanceTimersByTimeAsync(1_000);
    const second = sockets[1]!;
    second.open();
    await settle();
    second.server(registered());
    await settle();
    first.finishWrite();
    await settle();
    expect(second.sent.map((message) => message.type)).toEqual(["host:register", "session:status"]);
    transport.close();
  });
});

function register(commandProfiles: string[] = []) {
  return { type: "host:register" as const, hostId: "a1", worktrees: [], commandProfiles };
}

function registered() {
  return { type: "host:registered", hostId: "a1" };
}

function log(seq: number) {
  return {
    type: "session:log" as const,
    sessionId: "s1",
    stream: "stdout" as const,
    content: "log",
    timestamp: "2026-01-01T00:00:00.000Z",
    seq,
  };
}

function status() {
  return { type: "session:status" as const, sessionId: "s1", status: "completed" as const };
}

function assign(sessionId: string) {
  return {
    type: "session:assign" as const,
    sessionId,
    repositoryId: "r",
    prompt: "p",
    resolvedArgv: ["c"],
    timeout: 1,
    worktreeId: "w",
    assignedAt: "t",
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function settleMany(): Promise<void> {
  for (let index = 0; index < 8_000; index++) await Promise.resolve();
}
