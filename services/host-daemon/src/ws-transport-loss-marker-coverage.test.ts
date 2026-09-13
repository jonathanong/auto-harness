import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import { createWsTransport } from "./ws-transport.ts";
import { FakeSocket, registered, register } from "../test-helpers/ws-transport-test-helpers.ts";

afterEach(() => vi.useRealTimers());

describe("WebSocket transport loss-marker cleanup", () => {
  it("keeps a newer loss marker when an older marker write settles", async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const transport = createWsTransport({
      url: "ws://fake/ws",
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
      random: () => 0.5,
    });
    const first = sockets[0]!;
    first.open();
    await transport.send(register());
    first.server(registered());
    await transport.registered;

    first.delayNext = true;
    const failedLog = transport.send(log("first"));
    await settle();
    first.close();
    await expect(failedLog).rejects.toThrow("socket closed");

    await vi.advanceTimersByTimeAsync(1_000);
    const second = sockets[1]!;
    second.open();
    second.server(registered());

    // The first marker is now the in-flight write. A too-large log is dropped
    // synchronously, creating a newer marker before the first one's finally.
    const oversized = transport.send(log("x".repeat(4 * 1024 * 1024)));
    void oversized.catch(() => undefined);
    await settle();

    expect(second.sent.filter((message) => message.type === "session:log")).toHaveLength(2);
    transport.close();
  });
});

function log(content: string) {
  return {
    type: "session:log" as const,
    sessionId: "session-1",
    stream: "stdout" as const,
    content,
    timestamp: "2026-08-11T00:00:00.000Z",
    seq: 1,
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
