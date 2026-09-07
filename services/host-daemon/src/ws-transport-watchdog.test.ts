import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import { createWsTransport } from "./ws-transport.ts";
import { FakeSocket, register, registered, transportFor } from "./ws-transport-test-helpers.ts";

afterEach(() => vi.useRealTimers());

describe("registration watchdog", () => {
  it("re-arms on every reconnect, not just the first connect", async () => {
    // waitForRegistration in start-daemon.ts only ever guards the very first
    // connect — its promise resolves once and is never replaced. Before this
    // fix, a reconnect whose host:register never got acked left the socket
    // open, unregistered, and silently stuck forever.
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const errors: Error[] = [];
    const transport = createWsTransport({
      url: "ws://fake.test/ws",
      hostId: "a1",
      registrationTimeoutMs: 5_000,
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
      onError: (error) => errors.push(error),
      random: () => 0.5,
    });
    const first = sockets[0]!;
    first.open();
    await transport.send(register());
    first.server(registered());
    await transport.registered;

    // The server disappears; the reconnect's own register is never acknowledged.
    first.close();
    await vi.advanceTimersByTimeAsync(1_000);
    const second = sockets[1]!;
    second.open();
    await settle();
    expect(second.sent).toEqual([register()]);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(second.readyState).toBe(WebSocket.OPEN);
    await vi.advanceTimersByTimeAsync(1);
    expect(second.readyState).toBe(WebSocket.CLOSED);
    expect(errors.at(-1)?.message).toBe("registration not acknowledged within 5000ms");

    // The ladder keeps going after the watchdog's own close, same as any other disconnect.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sockets).toHaveLength(3);
    transport.close();
  });

  it("does not fire once host:registered arrives, and does not fire twice for one epoch", async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const errors: Error[] = [];
    const transport = transportForWithErrors(sockets, errors, 5_000);
    const first = sockets[0]!;
    first.open();
    await transport.send(register());
    first.server(registered());
    await transport.registered;

    await vi.advanceTimersByTimeAsync(10_000);
    expect(errors).toEqual([]);
    expect(first.readyState).toBe(WebSocket.OPEN);
    transport.close();
  });
});

describe("refreshSocket recovery", () => {
  it("falls back to the backoff ladder when the replacement connect throws synchronously", async () => {
    // refreshSocket's own disconnected(..., false) call deliberately arms no
    // retry — it expects the connect() right after it to be the replacement.
    // If that connect() itself throws (a synchronous socket-factory failure),
    // nothing used to catch it: the transport was left with socket === null
    // and no retry timer, silently wedged forever while the process kept running.
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const errors: Error[] = [];
    let throwNext = false;
    const transport = createWsTransport({
      url: "ws://fake.test/ws",
      hostId: "a1",
      socketFactory: () => {
        if (throwNext) {
          throwNext = false;
          throw new Error("EMFILE: too many open files");
        }
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
      onError: (error) => errors.push(error),
      random: () => 0.5,
    });
    const first = sockets[0]!;
    first.open();
    await transport.send(register(["old"]));
    first.server(registered());
    await transport.registered;

    throwNext = true;
    // A second host:register over the still-open connection takes the
    // refreshSocket() path; its replacement connect() is the one that throws.
    await expect(transport.send(register(["latest"]))).resolves.toBeUndefined();
    expect(errors.at(-1)?.message).toBe("EMFILE: too many open files");
    expect(sockets).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(sockets).toHaveLength(2);
    const second = sockets[1]!;
    second.open();
    await settle();
    expect(second.sent).toEqual([register(["latest"])]);
    transport.close();
  });
});

describe("forceReconnect", () => {
  it("closes the live socket and lets the normal reconnect ladder take over", async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const closes: number[] = [];
    const transport = createWsTransport({
      url: "ws://fake.test/ws",
      hostId: "a1",
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
      onClose: () => closes.push(sockets.length),
      random: () => 0.5,
    });
    const first = sockets[0]!;
    first.open();
    await transport.send(register());
    first.server(registered());
    await transport.registered;

    transport.forceReconnect?.("no successful keepalive in 45000ms");
    expect(first.readyState).toBe(WebSocket.CLOSED);
    expect(closes).toEqual([1]);
    expect(sockets).toHaveLength(1);

    // A redundant call while the backoff wait is already pending must not
    // start a second, competing reconnect attempt.
    transport.forceReconnect?.("redundant, still backing off");
    expect(sockets).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(sockets).toHaveLength(2);
    transport.close();
  });

  it("is a no-op once the transport itself is closed", () => {
    const sockets: FakeSocket[] = [];
    const transport = transportFor(sockets);
    sockets[0]!.open();
    transport.close();
    expect(() => transport.forceReconnect?.("after close")).not.toThrow();
  });
});

function transportForWithErrors(
  sockets: FakeSocket[],
  errors: Error[],
  registrationTimeoutMs: number,
) {
  return createWsTransport({
    url: "ws://fake.test/ws",
    hostId: "a1",
    registrationTimeoutMs,
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
    onError: (error) => errors.push(error),
    random: () => 0.5,
  });
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
