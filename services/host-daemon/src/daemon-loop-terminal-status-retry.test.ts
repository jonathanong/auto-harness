import { describe, expect, it } from "vitest";

import type { HostToServerMessage } from "@auto-harness/shared";

import { DaemonLoop, createLoopbackTransport } from "./daemon-loop.ts";
import { makeRepo } from "./daemon-loop-test-helpers.ts";

type PendingMap = Map<
  string,
  { message: HostToServerMessage; firstAttemptedAtMs: number; sending: boolean }
>;

function pendingTerminalStatusOf(loop: DaemonLoop): PendingMap {
  return (loop as unknown as { pendingTerminalStatus: PendingMap }).pendingTerminalStatus;
}

const statusMessage: Extract<HostToServerMessage, { type: "session:status" }> = {
  type: "session:status",
  sessionId: "done-session",
  worktreeId: null,
  attemptId: "attempt-1",
  status: "completed",
  exitCode: 0,
};

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("DaemonLoop terminal status retry", () => {
  it("reports a session with an unacknowledged terminal status as still owned, resends it on keepalive, and stops once acked", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const sent: HostToServerMessage[] = [];
      const transport = createLoopbackTransport({
        sendToServer: (message) => void sent.push(message),
      });
      const loop = new DaemonLoop({ config, transport, now: () => "now" });
      await loop.start();
      sent.length = 0;

      pendingTerminalStatusOf(loop).set("done-session\0attempt-1", {
        message: statusMessage,
        firstAttemptedAtMs: Date.now(),
        sending: false,
      });

      await loop.keepalive();
      expect(sent).toContainEqual(
        expect.objectContaining({ type: "host:keepalive", runningSessions: ["done-session"] }),
      );
      expect(sent.filter((message) => message.type === "session:status")).toHaveLength(1);

      transport.deliver({
        type: "session:status-acknowledged",
        sessionId: "done-session",
        attemptId: "attempt-1",
      });
      expect(pendingTerminalStatusOf(loop).size).toBe(0);

      sent.length = 0;
      await loop.keepalive();
      expect(sent.filter((message) => message.type === "session:status")).toHaveLength(0);
      expect(sent).toContainEqual(
        expect.objectContaining({ type: "host:keepalive", runningSessions: [] }),
      );

      loop.stop();
    } finally {
      cleanup();
    }
  });

  it("does not duplicate a retry while a prior attempt is still undelivered, and never blocks the keepalive frame on it", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      let statusSendAttempts = 0;
      const releasers: Array<() => void> = [];
      const keepalives: HostToServerMessage[] = [];
      const transport = createLoopbackTransport({
        sendToServer: (message) => {
          if (message.type === "session:status") {
            statusSendAttempts += 1;
            return new Promise<void>((resolve) => releasers.push(resolve));
          }
          keepalives.push(message);
          return undefined;
        },
      });
      const loop = new DaemonLoop({ config, transport, now: () => "now" });
      await loop.start();
      keepalives.length = 0;

      pendingTerminalStatusOf(loop).set("done-session\0attempt-1", {
        message: statusMessage,
        firstAttemptedAtMs: Date.now(),
        sending: false,
      });

      await loop.keepalive();
      expect(statusSendAttempts).toBe(1);
      expect(keepalives).toHaveLength(1);

      // A second tick while the first retry is still outstanding must not
      // enqueue a duplicate retained frame.
      await loop.keepalive();
      expect(statusSendAttempts).toBe(1);
      expect(keepalives).toHaveLength(2);

      releasers.splice(0).forEach((resolve) => resolve());
      await flushMicrotasks();

      await loop.keepalive();
      expect(statusSendAttempts).toBe(2);

      releasers.splice(0).forEach((resolve) => resolve());
      loop.stop();
    } finally {
      cleanup();
    }
  });

  it("gives up on an unacknowledged terminal status after the configured max age", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const sent: HostToServerMessage[] = [];
      const transport = createLoopbackTransport({
        sendToServer: (message) => void sent.push(message),
      });
      const loop = new DaemonLoop({
        config,
        transport,
        now: () => "now",
        pendingStatusMaxAgeMs: 1000,
      });
      await loop.start();
      sent.length = 0;

      pendingTerminalStatusOf(loop).set("done-session\0attempt-1", {
        message: statusMessage,
        firstAttemptedAtMs: Date.now() - 2000,
        sending: false,
      });

      await loop.keepalive();
      expect(sent.filter((message) => message.type === "session:status")).toHaveLength(0);
      expect(pendingTerminalStatusOf(loop).size).toBe(0);
      expect(sent).toContainEqual(
        expect.objectContaining({ type: "host:keepalive", runningSessions: [] }),
      );

      loop.stop();
    } finally {
      cleanup();
    }
  });
});
