import { describe, expect, it } from "vitest";

import { createWsTransport } from "./ws-transport.ts";
import { FakeSocket } from "./ws-transport-test-helpers.ts";

/**
 * A whole fleet loses its sockets at the same instant when the control plane restarts.
 * Without jitter every host walked the same 1s/2s/4s ladder in lockstep, so the reconnect
 * storm arrived in tight waves exactly when the control plane could least absorb it.
 */
function waitsFor(random: () => number, reconnects: number): number[] {
  const waits: number[] = [];
  const pending: Array<() => void> = [];
  const sockets: FakeSocket[] = [];
  const transport = createWsTransport({
    url: "ws://fake.test/ws",
    hostId: "a1",
    random,
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
    timers: {
      setTimeout: ((callback: () => void, ms?: number) => {
        waits.push(ms ?? 0);
        pending.push(callback);
        return 0 as never;
      }) as typeof globalThis.setTimeout,
      clearTimeout: (() => undefined) as typeof globalThis.clearTimeout,
    },
  });
  for (let i = 0; i < reconnects; i += 1) {
    sockets.at(-1)?.close();
    pending.shift()?.();
  }
  transport.close();
  return waits;
}

describe("reconnect jitter", () => {
  it("keeps the nominal ladder at the midpoint of the jitter range", () => {
    expect(waitsFor(() => 0.5, 3)).toEqual([1_000, 2_000, 4_000]);
  });

  it("spreads two hosts that disconnected at the same instant", () => {
    const early = waitsFor(() => 0, 3);
    const late = waitsFor(() => 1, 3);

    expect(early).toEqual([500, 1_000, 2_000]);
    expect(late).toEqual([1_500, 3_000, 6_000]);
    // Same ladder, no shared boundary: the two fleets never retry together.
    for (const [index, wait] of early.entries()) expect(wait).not.toBe(late[index]);
  });

  it("still doubles the underlying delay regardless of the jitter drawn", () => {
    const waits = waitsFor(() => 0.25, 4);

    for (let i = 1; i < waits.length; i += 1) {
      expect(waits[i]).toBe(waits[i - 1]! * 2);
    }
  });
});
