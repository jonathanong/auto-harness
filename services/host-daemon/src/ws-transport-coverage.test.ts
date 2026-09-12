/* eslint-disable max-lines -- residual runtime branches share one FakeSocket harness. */
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import { createWsTransport } from "./ws-transport.ts";
import { FakeSocket } from "../test-helpers/ws-transport-test-helpers.ts";

afterEach(() => vi.useRealTimers());

describe("WebSocket transport residual runtime branches", () => {
  it("builds authenticated and anonymous socket targets", async () => {
    const seen: unknown[] = [];
    const first = createWsTransport({
      url: "ws://example.test/ws?existing=1",
      hostId: "host one",
      apiKey: "secret",
      socketFactory: (url, init) => {
        seen.push([url, init]);
        return new FakeSocket() as unknown as WebSocket;
      },
    });
    const second = createWsTransport({
      url: "ws://example.test/ws",
      socketFactory: (url, init) => {
        seen.push([url, init]);
        return new FakeSocket() as unknown as WebSocket;
      },
    });
    expect(seen).toEqual([
      [
        "ws://example.test/ws?existing=1&hostId=host%20one",
        {
          headers: { authorization: "Bearer secret" },
        },
      ],
      ["ws://example.test/ws", undefined],
    ]);
    first.close();
    second.close();
    await expect(
      second.send({ type: "host:keepalive", hostId: "host", at: "now" }),
    ).rejects.toThrow("WebSocket transport closed");
  });

  it("notifies lifecycle handlers and admits only valid server control frames", async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const events: string[] = [];
    const received: string[] = [];
    const errors: Error[] = [];
    const transport = createWsTransport({
      url: "ws://fake/ws",
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
      onOpen: () => events.push("open"),
      onClose: () => events.push("close"),
      onError: (error) => errors.push(error),
    });
    let negotiated: number | undefined;
    transport.onConnected?.(() => events.push("connected"));
    transport.onRegistered?.((protocolVersion) => {
      events.push("registered");
      negotiated = protocolVersion;
    });
    transport.onDisconnected?.(() => events.push("disconnected"));
    transport.onMessage((message) => received.push(message.type));
    const socket = sockets[0]!;
    socket.open();
    await transport.send(register());
    socket.server({ type: "host:keepalive-ack", hostId: "host-1", at: "now" });
    socket.server({ type: "host:registered", hostId: "host-1", protocolVersion: 2 });
    await transport.registered;
    expect(negotiated).toBe(2);
    socket.emit("message", Buffer.from("{"));
    for (const message of [
      { type: "session:acknowledged", sessionId: "", attemptId: "a" },
      { type: "session:acknowledged", sessionId: "x".repeat(513), attemptId: "a" },
      { type: "session:acknowledged", sessionId: "session-1", attemptId: "a" },
      { type: "session:assign" },
      { type: "session:cancel", sessionId: "session-1", attemptId: "a" },
      { type: "session:acknowledged", sessionId: "session-2" },
      { type: "session:cancel", sessionId: "session-2" },
      {
        type: "session:terminal-hook",
        handoffId: "handoff-1",
        sessionId: "session-3",
        repositoryId: "repository-1",
        worktreeId: null,
        status: "failed",
        expiresAt: "2026-01-02T00:00:00.000Z",
        errorCode: "host_lost",
        ref: "main",
        metadata: { source: "recovery" },
      },
      {
        type: "session:terminal-hook-acknowledged",
        handoffId: "handoff-1",
        sessionId: "session-3",
      },
      {
        type: "session:terminal-hook",
        handoffId: "handoff-2",
        sessionId: "session-4",
        repositoryId: "repository-1",
        worktreeId: "worktree-1",
        status: "queued",
      },
      {
        type: "session:terminal-hook-acknowledged",
        handoffId: 42,
        sessionId: "session-3",
      },
      { type: "host:drain" },
      { type: "host:keepalive-ack", hostId: "host-1", at: "now" },
    ])
      socket.server(message);
    await settle();
    expect(received).toEqual([
      "session:acknowledged",
      "session:assign",
      "session:cancel",
      "session:acknowledged",
      "session:cancel",
      "session:terminal-hook",
      "session:terminal-hook-acknowledged",
      "host:drain",
      "host:keepalive-ack",
    ]);
    socket.emit("error", "primitive failure");
    expect(errors[0]).toEqual(new Error("primitive failure"));
    expect(events).toEqual(["open", "connected", "registered", "close", "disconnected"]);
    transport.close();
  });

  it("reports current registration write failures but ignores stale ones", async () => {
    const sockets: FakeSocket[] = [];
    const errors: Error[] = [];
    const transport = createWsTransport({
      url: "ws://fake/ws",
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
      onError: (error) => errors.push(error),
    });
    const first = sockets[0]!;
    first.open();
    first.failNext = new Error("stale registration");
    first.delayNext = true;
    await transport.send(register(["old"]));
    await transport.send(register(["new"]));
    first.finishWrite();
    await settle();
    expect(errors).toEqual([]);

    const second = sockets[1]!;
    second.failNext = new Error("current registration");
    second.open();
    await settle();
    expect(errors).toEqual([new Error("current registration")]);
    transport.close();
  });

  it("rejects both droppable logs and critical frames closed during a write", async () => {
    await expectClosedInflight(log());
    await expectClosedInflight({
      type: "session:status",
      sessionId: "session-1",
      status: "completed",
    });
  });

  it("reports an Error socket failure after registration", async () => {
    const sockets: FakeSocket[] = [];
    const errors: Error[] = [];
    const transport = createWsTransport({
      url: "ws://fake/ws",
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
      onError: (error) => errors.push(error),
    });
    const socket = sockets[0]!;
    socket.open();
    await transport.send(register());
    socket.server({ type: "host:registered", hostId: "host-1" });
    await transport.registered;
    socket.emit("error", new Error("socket exploded"));
    expect(errors.map((error) => error.message)).toContain("socket exploded");
    transport.close();
  });

  it("closes a refresh when disconnect already shut the transport down", async () => {
    const sockets: FakeSocket[] = [];
    let transport: ReturnType<typeof createWsTransport>;
    transport = createWsTransport({
      url: "ws://fake/ws",
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
      onClose: () => transport.close(),
    });
    const socket = sockets[0]!;
    socket.open();
    await transport.send(register());
    socket.server({ type: "host:registered", hostId: "host-1" });
    await transport.registered;
    await transport.send(register(["next"]));
    expect(sockets).toHaveLength(1);
  });

  it("records a disconnected log that never carried an attempt id", async () => {
    await expectClosedInflight({
      type: "session:log",
      sessionId: "session-1",
      stream: "stdout",
      content: "line",
      timestamp: "2026-08-11T00:00:00.000Z",
      seq: 1,
    });
  });
});

async function expectClosedInflight(
  message: Parameters<ReturnType<typeof createWsTransport>["send"]>[0],
) {
  const sockets: FakeSocket[] = [];
  const transport = createWsTransport({
    url: "ws://fake/ws",
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
  });
  const socket = sockets[0]!;
  socket.open();
  await transport.send(register());
  socket.server({ type: "host:registered", hostId: "host-1" });
  await transport.registered;
  socket.delayNext = true;
  const delivery = transport.send(message);
  void delivery?.catch(() => undefined);
  await settle();
  transport.close();
  await expect(delivery).rejects.toThrow();
}

function register(commandProfiles: string[] = []) {
  return { type: "host:register" as const, hostId: "host-1", worktrees: [], commandProfiles };
}

function log() {
  return {
    type: "session:log" as const,
    sessionId: "session-1",
    attemptId: "a",
    stream: "stdout" as const,
    content: "line",
    timestamp: "2026-08-11T00:00:00.000Z",
    seq: 1,
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
