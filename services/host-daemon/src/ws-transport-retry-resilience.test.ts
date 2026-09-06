import { describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import { createWsTransport } from "./ws-transport.ts";
import { FakeSocket, register, registered } from "./ws-transport-test-helpers.ts";

describe("reconnect resilience to a failing socket factory", () => {
  it("keeps backing off instead of crashing when the socket factory keeps throwing synchronously", async () => {
    // Sustained EMFILE pressure (the exact scenario this repo's node-pty fd-leak
    // fix targets) can make `new WebSocket(...)` throw synchronously, repeatedly.
    // refreshSocket() already survives the *first* such failure by catching it
    // and calling retryLater() — but retryLater()'s own scheduled connect() call
    // used to have no try/catch of its own, so every failure after the first
    // would escape as an uncaught exception inside a timer callback and crash
    // the whole daemon process, not just this connection.
    vi.useFakeTimers();
    try {
      const errors: Error[] = [];
      let attempt = 0;
      const sockets: FakeSocket[] = [];
      const transport = createWsTransport({
        url: "ws://fake.test/ws",
        hostId: "a1",
        onError: (error) => errors.push(error),
        random: () => 0.5,
        socketFactory: () => {
          attempt += 1;
          if (attempt === 1) {
            const socket = new FakeSocket();
            sockets.push(socket);
            return socket as unknown as WebSocket;
          }
          throw new Error(`EMFILE (attempt ${attempt})`);
        },
      });
      const socket = sockets[0]!;
      socket.open();
      await transport.send(register());
      socket.server(registered("c1"));
      await transport.registered;

      errors.length = 0;
      // A second host:register while already open+registered triggers
      // refreshSocket(), whose own connect() call now hits the throwing factory.
      await transport.send(register());
      expect(errors.map((e) => e.message)).toEqual(["EMFILE (attempt 2)"]);

      // retryLater()'s scheduled connect() call must survive every subsequent
      // failure too, rather than throwing uncaught inside the timer — the
      // whole ladder keeps retrying (backing off further each time) instead
      // of crashing the daemon process partway through.
      expect(() => vi.advanceTimersByTime(30_000)).not.toThrow();
      expect(errors.map((e) => e.message)).toEqual([
        "EMFILE (attempt 2)",
        "EMFILE (attempt 3)",
        "EMFILE (attempt 4)",
        "EMFILE (attempt 5)",
        "EMFILE (attempt 6)",
      ]);
      transport.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
