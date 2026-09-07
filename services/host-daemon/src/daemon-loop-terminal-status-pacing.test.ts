import { describe, expect, it } from "vitest";

import type { HostToServerMessage } from "@auto-harness/shared";

import { DaemonLoop, createLoopbackTransport } from "./daemon-loop.ts";
import {
  flushMacrotask,
  makeRepo,
  pendingTerminalStatusOf,
  terminalStatusFixture,
} from "./daemon-loop-test-helpers.ts";

function statusFor(sessionId: string): Extract<HostToServerMessage, { type: "session:status" }> {
  return { ...terminalStatusFixture, sessionId, attemptId: `attempt-${sessionId}` };
}

describe("DaemonLoop terminal status retry pacing", () => {
  it("spreads a large backlog across multiple keepalive ticks instead of bursting it in one", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const sentSessionIds: string[] = [];
      const transport = createLoopbackTransport({
        sendToServer: (message) => {
          if (message.type === "session:status") sentSessionIds.push(message.sessionId);
        },
      });
      const loop = new DaemonLoop({
        config,
        transport,
        now: () => "now",
        statusRetriesPerTick: 2,
      });
      await loop.start();

      for (const sessionId of ["a", "b", "c"]) {
        pendingTerminalStatusOf(loop).set(`${sessionId}\0attempt-${sessionId}`, {
          message: statusFor(sessionId),
          firstAttemptedAtMs: Date.now(),
          sending: false,
          controller: new AbortController(),
        });
      }

      await loop.keepalive();
      await flushMacrotask();
      // A control plane that never acknowledges (e.g. not yet upgraded) could
      // otherwise have every retained status resent in a single tick; over a
      // large enough backlog that risks tripping the server's per-connection
      // message-rate limit. Only statusRetriesPerTick may go out per tick.
      expect(sentSessionIds).toHaveLength(2);
      const skippedOnFirstTick = ["a", "b", "c"].find((id) => !sentSessionIds.includes(id))!;

      await loop.keepalive();
      await flushMacrotask();
      // The entry excluded from the first tick must get its turn on the
      // next one: fair rotation, not starvation of whichever entry sorts last.
      expect(sentSessionIds.slice(2)).toContain(skippedOnFirstTick);

      loop.stop();
    } finally {
      cleanup();
    }
  });
});
