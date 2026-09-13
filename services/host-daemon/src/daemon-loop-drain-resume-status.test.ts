import { describe, expect, it } from "vitest";

import type { HostToServerMessage } from "@auto-harness/shared";

import { DaemonLoop, createLoopbackTransport } from "./daemon-loop.ts";
import {
  flushMicrotasks,
  makeRepo,
  pendingTerminalStatusOf,
  terminalStatusFixture as statusMessage,
} from "../test-helpers/daemon-loop-test-helpers.ts";

describe("DaemonLoop drain resume terminal status", () => {
  it("re-arms deferred terminal status sends after a failed auto-update drain", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const sent: HostToServerMessage[] = [];
      const transport = createLoopbackTransport({
        sendToServer: (message) => {
          sent.push(message);
        },
      });
      const loop = new DaemonLoop({ config, transport, now: () => "now" });
      await loop.start();
      const controller = new AbortController();
      pendingTerminalStatusOf(loop).set("done-session\0attempt-1", {
        message: { ...statusMessage, errorCode: "checkout_fetch_failed" },
        firstAttemptedAtMs: Date.now(),
        sending: false,
        controller,
        settleDeferredTerminalHook: async () => undefined,
      });

      loop.prepareForShutdown();
      expect(controller.signal.aborted).toBe(true);
      expect(pendingTerminalStatusOf(loop).size).toBe(1);

      await loop.resumeFromDrain();
      await flushMicrotasks();
      expect(
        pendingTerminalStatusOf(loop).get("done-session\0attempt-1")?.controller.signal.aborted,
      ).toBe(false);
      expect(sent).toContainEqual(
        expect.objectContaining({
          type: "session:status",
          sessionId: "done-session",
          errorCode: "checkout_fetch_failed",
        }),
      );

      transport.deliver({
        type: "session:status-acknowledged",
        sessionId: "done-session",
        attemptId: "attempt-1",
        retryAccepted: true,
      });
      await flushMicrotasks();
      expect(pendingTerminalStatusOf(loop).size).toBe(0);
      loop.stop();
    } finally {
      cleanup();
    }
  });
});
