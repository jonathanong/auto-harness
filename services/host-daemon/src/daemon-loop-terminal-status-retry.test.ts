import { describe, expect, it } from "vitest";

import type { HostToServerMessage } from "@auto-harness/shared";

import { DaemonLoop, createLoopbackTransport } from "./daemon-loop.ts";
import {
  createAcknowledgingLoopbackTransport,
  flushMacrotask,
  flushMicrotasks,
  makeRepo,
  pendingTerminalStatusOf,
  terminalStatusFixture as statusMessage,
} from "./daemon-loop-test-helpers.ts";

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
        controller: new AbortController(),
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
        controller: new AbortController(),
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

  it("logs a failed initial send, retries on keepalive, and clears on a sessionId-only ack", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const lines: string[] = [];
      let statusAttempts = 0;
      const transport = createAcknowledgingLoopbackTransport({
        sendToServer: (message) => {
          if (message.type === "session:status") {
            statusAttempts += 1;
            if (statusAttempts <= 2) throw new Error(`send failed #${String(statusAttempts)}`);
          }
        },
      });
      const loop = new DaemonLoop({ config, transport, onLog: (line) => lines.push(line) });
      await loop.start();

      transport.deliver({
        type: "session:assign",
        sessionId: "flaky-status",
        repositoryId: "demo",
        prompt: "hello",
        resolvedArgv: ["printf", "%s", "hello"],
        timeout: 30,
        worktreeId: "wt-1",
        attemptId: "attempt-flaky-status",
        assignedAt: new Date().toISOString(),
      });
      await loop.waitForIdle();

      expect(statusAttempts).toBe(1);
      expect(
        lines.some((line) => line.includes("session:status send failed for flaky-status")),
      ).toBe(true);
      expect(pendingTerminalStatusOf(loop).size).toBe(1);

      await loop.keepalive();
      await flushMacrotask();
      expect(statusAttempts).toBe(2);
      expect(
        lines.some((line) => line.includes("terminal status retry failed for flaky-status")),
      ).toBe(true);

      await loop.keepalive();
      await flushMacrotask();
      expect(statusAttempts).toBe(3);

      transport.deliver({ type: "session:status-acknowledged", sessionId: "flaky-status" });
      expect(pendingTerminalStatusOf(loop).size).toBe(0);

      loop.stop();
    } finally {
      cleanup();
    }
  });

  it("gives up on an unacknowledged terminal status after the configured max age", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const sent: HostToServerMessage[] = [];
      const lines: string[] = [];
      const transport = createLoopbackTransport({
        sendToServer: (message) => void sent.push(message),
      });
      const loop = new DaemonLoop({
        config,
        transport,
        now: () => "now",
        pendingStatusMaxAgeMs: 1000,
        onLog: (line) => lines.push(line),
      });
      await loop.start();
      sent.length = 0;

      const controller = new AbortController();
      pendingTerminalStatusOf(loop).set("done-session\0attempt-1", {
        message: statusMessage,
        firstAttemptedAtMs: Date.now() - 2000,
        sending: false,
        controller,
      });

      await loop.keepalive();
      expect(sent.filter((message) => message.type === "session:status")).toHaveLength(0);
      expect(pendingTerminalStatusOf(loop).size).toBe(0);
      expect(
        lines.some((line) =>
          line.includes("giving up on unacknowledged terminal status for done-session"),
        ),
      ).toBe(true);
      expect(sent).toContainEqual(
        expect.objectContaining({ type: "host:keepalive", runningSessions: [] }),
      );
      // Giving up must cancel a still-buffered retained frame rather than
      // leaving it queued to transmit whenever the connection recovers.
      expect(controller.signal.aborted).toBe(true);

      loop.stop();
    } finally {
      cleanup();
    }
  });
});
