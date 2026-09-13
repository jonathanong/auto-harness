import { describe, expect, it } from "vitest";

import type { HostToServerMessage, HostWireMessage } from "@auto-harness/shared";

import { DaemonLoop } from "./daemon-loop.ts";
import {
  createAcknowledgingLoopbackTransport,
  flushMacrotask,
  makeRepo,
} from "../test-helpers/daemon-loop-test-helpers.ts";

function assignment(
  sessionId: string,
  worktreeId: string,
): Extract<HostWireMessage, { type: "session:assign" }> {
  return {
    type: "session:assign",
    sessionId,
    attemptId: `attempt-${sessionId}`,
    repositoryId: "demo",
    prompt: sessionId,
    resolvedArgv: ["printf", "%s", sessionId],
    timeout: 30,
    worktreeId,
    assignedAt: new Date().toISOString(),
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (predicate()) return;
    await flushMacrotask();
  }
  throw new Error("condition did not become true");
}

describe("DaemonLoop deferred terminal-hook assignment capacity", () => {
  it("holds maxConcurrentAssignments until deferred settlement succeeds or fails", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const sent: HostToServerMessage[] = [];
      const lines: string[] = [];
      const transport = createAcknowledgingLoopbackTransport({
        sendToServer: (message) => void sent.push(message),
      });
      const loop = new DaemonLoop({
        config,
        transport,
        onLog: (line) => lines.push(line),
        executionProfiles: { maxConcurrentAssignments: 1, profiles: new Map() },
      });
      const started: string[] = [];
      let finishHook!: (error?: Error) => void;
      (
        loop as unknown as {
          runner: {
            run(assign: { sessionId: string }): Promise<{
              status: "failed" | "completed";
              exitCode: number | null;
              logs: [];
              errorCode?: "checkout_fetch_failed";
              settleDeferredTerminalHook?: (runHook: boolean) => Promise<void>;
            }>;
          };
        }
      ).runner = {
        async run(assign) {
          started.push(assign.sessionId);
          if (assign.sessionId === "checkout-failure") {
            return {
              status: "failed",
              exitCode: null,
              logs: [],
              errorCode: "checkout_fetch_failed",
              settleDeferredTerminalHook: () =>
                new Promise((resolve, reject) => {
                  finishHook = (error) => (error ? reject(error) : resolve());
                }),
            };
          }
          return { status: "completed", exitCode: 0, logs: [] };
        },
      };
      await loop.start();
      transport.deliver({ type: "host:registered", hostId: config.hostId, protocolVersion: 6 });
      transport.deliver(assignment("checkout-failure", "wt-1"));
      await waitFor(() =>
        sent.some(
          (message) =>
            message.type === "session:status" && message.sessionId === "checkout-failure",
        ),
      );

      transport.deliver({
        type: "session:status-acknowledged",
        sessionId: "checkout-failure",
        attemptId: "attempt-checkout-failure",
        retryAccepted: false,
      });
      await waitFor(() => finishHook !== undefined);

      transport.deliver(assignment("other-session", "wt-2"));
      await flushMacrotask();
      expect(started).toEqual(["checkout-failure"]);
      expect(lines).toContain("session capacity reached: refused assign other-session");

      finishHook();
      await loop.waitForIdle();
      expect(started).toEqual(["checkout-failure"]);

      transport.deliver(assignment("after-success", "wt-2"));
      await loop.waitForIdle();
      expect(started).toEqual(["checkout-failure", "after-success"]);

      let failHook!: (error?: Error) => void;
      (
        loop as unknown as {
          runner: {
            run(assign: { sessionId: string }): Promise<{
              status: "failed" | "completed";
              exitCode: number | null;
              logs: [];
              errorCode?: "checkout_fetch_failed";
              settleDeferredTerminalHook?: (runHook: boolean) => Promise<void>;
            }>;
          };
        }
      ).runner = {
        async run(assign) {
          started.push(assign.sessionId);
          if (assign.sessionId === "checkout-failure-again") {
            return {
              status: "failed",
              exitCode: null,
              logs: [],
              errorCode: "checkout_fetch_failed",
              settleDeferredTerminalHook: () =>
                new Promise((resolve, reject) => {
                  failHook = (error) => (error ? reject(error) : resolve());
                }),
            };
          }
          return { status: "completed", exitCode: 0, logs: [] };
        },
      };
      transport.deliver(assignment("checkout-failure-again", "wt-1"));
      await waitFor(() =>
        sent.some(
          (message) =>
            message.type === "session:status" && message.sessionId === "checkout-failure-again",
        ),
      );
      transport.deliver({
        type: "session:status-acknowledged",
        sessionId: "checkout-failure-again",
        attemptId: "attempt-checkout-failure-again",
        retryAccepted: false,
      });
      await waitFor(() => failHook !== undefined);
      transport.deliver(assignment("during-failure", "wt-2"));
      await flushMacrotask();
      expect(started).toEqual(["checkout-failure", "after-success", "checkout-failure-again"]);
      expect(lines).toContain("session capacity reached: refused assign during-failure");
      failHook(new Error("hook failed"));
      await loop.waitForIdle();
      transport.deliver(assignment("after-failure", "wt-2"));
      await loop.waitForIdle();
      expect(started).toEqual([
        "checkout-failure",
        "after-success",
        "checkout-failure-again",
        "after-failure",
      ]);
      loop.stop();
    } finally {
      cleanup();
    }
  });
});
