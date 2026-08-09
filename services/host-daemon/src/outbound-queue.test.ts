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
});
