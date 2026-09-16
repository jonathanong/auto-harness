import { describe, expect, it } from "vitest";

import { DaemonLoop, createLoopbackTransport } from "./daemon-loop.ts";
import { makeRepo } from "../test-helpers/daemon-loop-test-helpers.ts";

describe("DaemonLoop operator resume", () => {
  it("an operator host:resume clears an operator-initiated drain and re-registers", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const sent: Array<{ type: string }> = [];
      const transport = createLoopbackTransport({
        sendToServer: (message) => void sent.push(message),
      });
      const loop = new DaemonLoop({ config, transport });
      await loop.start();
      sent.length = 0;

      // Purely operator-driven: no local beginDrain() call, matching how an
      // operator's POST /hosts/drain reaches an idle daemon with no prior
      // local drain intent at all.
      transport.deliver({ type: "host:drain" });
      expect(loop.isDraining()).toBe(true);

      transport.deliver({ type: "host:resume" });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(loop.isDraining()).toBe(false);
      expect(sent.some((message) => message.type === "host:register")).toBe(true);
      loop.stop();
    } finally {
      cleanup();
    }
  });

  it("resuming a host that isn't draining is harmless (re-registers, does not throw)", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const sent: Array<{ type: string }> = [];
      const transport = createLoopbackTransport({
        sendToServer: (message) => void sent.push(message),
      });
      const loop = new DaemonLoop({ config, transport });
      await loop.start();
      sent.length = 0;

      expect(loop.isDraining()).toBe(false);
      transport.deliver({ type: "host:resume" });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(loop.isDraining()).toBe(false);
      expect(sent.some((message) => message.type === "host:register")).toBe(true);
      loop.stop();
    } finally {
      cleanup();
    }
  });
});
