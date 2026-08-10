import { describe, expect, it } from "vitest";

import type { HostToServerMessage } from "@auto-harness/shared";

import { OutboundQueue } from "./outbound-queue.ts";

const keepalive = (at: string): HostToServerMessage => ({
  type: "host:keepalive",
  hostId: "h",
  at,
});

describe("OutboundQueue", () => {
  it("delegates delivery and reports the transport failure", async () => {
    const reports: string[] = [];
    const queue = new OutboundQueue(
      {
        async send() {
          throw new Error("offline");
        },
        onMessage() {},
        close() {},
      },
      (line) => reports.push(line),
    );

    await expect(queue.send(keepalive("first"))).rejects.toThrow("offline");
    await queue.flush();
    expect(reports).toEqual(["outbound host:keepalive failed: offline"]);
  });

  it("waits only for the single transport-owned FIFO deliveries already started", async () => {
    const sent: HostToServerMessage[] = [];
    let release: (() => void) | undefined;
    const queue = new OutboundQueue(
      {
        send(message) {
          sent.push(message);
          return new Promise<void>((resolve) => {
            release = resolve;
          });
        },
        onMessage() {},
        close() {},
      },
      () => {},
    );

    const delivery = queue.send(keepalive("first"));
    const flushed = queue.flush();
    expect(sent).toEqual([keepalive("first")]);
    expect(release).toBeDefined();
    release?.();
    await expect(Promise.all([delivery, flushed])).resolves.toEqual([undefined, undefined]);
  });
});
