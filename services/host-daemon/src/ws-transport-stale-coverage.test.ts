import { expect, it, vi } from "vitest";
import WebSocket from "ws";

import { createWsTransport } from "./ws-transport.ts";
import { FakeSocket } from "../test-helpers/ws-transport-test-helpers.ts";

it("ignores a stale rejected write callback after disconnecting", async () => {
  vi.useFakeTimers();
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
  await transport.send({
    type: "host:register",
    hostId: "host-1",
    worktrees: [],
    commandProfiles: [],
  });
  socket.server({ type: "host:registered", hostId: "host-1" });
  await transport.registered;
  socket.failNext = new Error("late failure");
  socket.delayNext = true;
  const delivery = transport.send({
    type: "session:status",
    sessionId: "session-1",
    status: "completed",
  });
  void delivery?.catch(() => undefined);
  await settle();
  socket.close();
  socket.finishWrite();
  await settle();
  transport.close();
  await expect(delivery).rejects.toThrow();
  vi.useRealTimers();
});

it("ignores an error emitted by a socket that has already been replaced", async () => {
  vi.useFakeTimers();
  try {
    const sockets: FakeSocket[] = [];
    const errors: Error[] = [];
    const transport = createWsTransport({
      url: "ws://fake/ws",
      onError: (error) => errors.push(error),
      random: () => 0.5,
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
    });
    const first = sockets[0]!;
    first.open();
    await transport.send({
      type: "host:register",
      hostId: "host-1",
      worktrees: [],
      commandProfiles: [],
    });
    first.server({ type: "host:registered", hostId: "host-1" });
    await transport.registered;

    first.close();
    await vi.advanceTimersByTimeAsync(1_000);
    const replacement = sockets[1]!;
    replacement.open();
    first.emit("error", new Error("late socket error"));

    expect(errors).toEqual([]);
    transport.close();
  } finally {
    vi.useRealTimers();
  }
});

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
