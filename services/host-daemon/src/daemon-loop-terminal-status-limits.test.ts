import { describe, expect, it } from "vitest";

import type { HostToServerMessage } from "@auto-harness/shared";

import { DaemonLoop, createLoopbackTransport } from "./daemon-loop.ts";
import {
  createAcknowledgingLoopbackTransport,
  makeRepo,
  pendingTerminalStatusOf,
  terminalStatusFixture as statusMessage,
} from "../test-helpers/daemon-loop-test-helpers.ts";

describe("DaemonLoop terminal status bookkeeping limits", () => {
  it("does not double-report an attempt present in both inflight and pendingTerminalStatus", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const sent: HostToServerMessage[] = [];
      const transport = createLoopbackTransport({
        sendToServer: (message) => void sent.push(message),
      });
      const loop = new DaemonLoop({ config, transport, now: () => "now" });
      await loop.start();

      // runAssign records the pending status before its send settles, so for a
      // brief window the same attempt is present in both inflight (not yet
      // cleaned up by handleAssign's finally) and pendingTerminalStatus.
      (
        loop as unknown as {
          inflight: Map<
            string,
            {
              sessionId: string;
              attemptId: string;
              controller: AbortController;
              work: Promise<void>;
              acknowledged: boolean;
            }
          >;
        }
      ).inflight.set("dup-session\0attempt-dup", {
        sessionId: "dup-session",
        attemptId: "attempt-dup",
        controller: new AbortController(),
        work: Promise.resolve(),
        acknowledged: true,
      });
      pendingTerminalStatusOf(loop).set("dup-session\0attempt-dup", {
        message: { ...statusMessage, sessionId: "dup-session", attemptId: "attempt-dup" },
        firstAttemptedAtMs: Date.now(),
        sending: false,
        controller: new AbortController(),
      });

      sent.length = 0;
      await loop.register();
      const register = sent.find((message) => message.type === "host:register");
      expect(register).toMatchObject({
        runningSessions: ["dup-session"],
        runningAttempts: [{ sessionId: "dup-session", attemptId: "attempt-dup" }],
      });

      loop.stop();
    } finally {
      cleanup();
    }
  });

  it("stops retaining new pending statuses once the retry buffer is full", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const lines: string[] = [];
      const transport = createAcknowledgingLoopbackTransport({
        sendToServer: () => {
          // Every session:status send "succeeds" (reaches the kernel buffer)
          // but is never acknowledged, so nothing ever clears on its own.
        },
      });
      const loop = new DaemonLoop({
        config,
        transport,
        onLog: (line) => lines.push(line),
        pendingStatusMaxCount: 1,
      });
      await loop.start();

      transport.deliver({
        type: "session:assign",
        sessionId: "first",
        repositoryId: "demo",
        prompt: "hello",
        resolvedArgv: ["printf", "%s", "hello"],
        timeout: 30,
        worktreeId: "wt-1",
        attemptId: "attempt-first",
        assignedAt: new Date().toISOString(),
      });
      await loop.waitForIdle();
      expect(pendingTerminalStatusOf(loop).size).toBe(1);

      transport.deliver({
        type: "session:assign",
        sessionId: "second",
        repositoryId: "demo",
        prompt: "hello",
        resolvedArgv: ["printf", "%s", "hello"],
        timeout: 30,
        worktreeId: "wt-1",
        attemptId: "attempt-second",
        assignedAt: new Date().toISOString(),
      });
      await loop.waitForIdle();

      // Still just the first: the second was refused retention at capacity
      // rather than growing the set without bound.
      expect(pendingTerminalStatusOf(loop).size).toBe(1);
      expect([...pendingTerminalStatusOf(loop).values()][0]?.message.sessionId).toBe("first");
      expect(lines.some((line) => line.includes("terminal status retry buffer full"))).toBe(true);

      loop.stop();
    } finally {
      cleanup();
    }
  });
});
