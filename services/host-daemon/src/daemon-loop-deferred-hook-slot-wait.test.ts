import { describe, expect, it } from "vitest";

import type { HostToServerMessage, HostWireMessage } from "@auto-harness/shared";

import { DaemonLoop } from "./daemon-loop.ts";
import {
  createAcknowledgingLoopbackTransport,
  flushMacrotask,
  makeRepo,
  pendingTerminalStatusOf,
  terminalStatusFixture,
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

describe("DaemonLoop deferred hook slot wait", () => {
  it("does not deadlock a deferred hook that waits for a slot taken during ACK wait", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const sent: HostToServerMessage[] = [];
      const transport = createAcknowledgingLoopbackTransport({
        sendToServer: (message) => void sent.push(message),
      });
      const loop = new DaemonLoop({
        config,
        transport,
        executionProfiles: { maxConcurrentAssignments: 1, profiles: new Map() },
      });
      const started: string[] = [];
      let finishHook!: () => void;
      let finishOther!: () => void;
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
                new Promise((resolve) => {
                  finishHook = resolve;
                }),
            };
          }
          await new Promise<void>((resolve) => {
            finishOther = resolve;
          });
          return { status: "completed", exitCode: 0, logs: [] };
        },
      };
      await loop.start();
      transport.deliver({ type: "host:registered", hostId: config.hostId, protocolVersion: 7 });
      transport.deliver(assignment("checkout-failure", "wt-1"));
      await waitFor(() =>
        sent.some(
          (message) =>
            message.type === "session:status" && message.sessionId === "checkout-failure",
        ),
      );
      transport.deliver(assignment("other-session", "wt-2"));
      await waitFor(() => started.includes("other-session"));

      transport.deliver({
        type: "session:status-acknowledged",
        sessionId: "checkout-failure",
        attemptId: "attempt-checkout-failure",
        retryAccepted: false,
      });
      await flushMacrotask();
      expect(finishHook).toBeUndefined();

      finishOther();
      await waitFor(() => finishHook !== undefined);
      finishHook();
      await loop.waitForIdle();
      expect(started).toEqual(["checkout-failure", "other-session"]);
      loop.stop();
    } finally {
      cleanup();
    }
  });

  it("occupies capacity for a deferred ACK that has no inflight entry", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const transport = createAcknowledgingLoopbackTransport({
        sendToServer: () => undefined,
      });
      const lines: string[] = [];
      const loop = new DaemonLoop({
        config,
        transport,
        onLog: (line) => lines.push(line),
        executionProfiles: { maxConcurrentAssignments: 1, profiles: new Map() },
      });
      const started: string[] = [];
      let finishHook!: () => void;
      (
        loop as unknown as {
          runner: {
            run(assign: { sessionId: string }): Promise<{
              status: "completed";
              exitCode: number;
              logs: [];
            }>;
          };
        }
      ).runner = {
        async run(assign) {
          started.push(assign.sessionId);
          return { status: "completed", exitCode: 0, logs: [] };
        },
      };
      pendingTerminalStatusOf(loop).set("lost\0attempt", {
        message: { ...terminalStatusFixture, sessionId: "lost", attemptId: "attempt" },
        firstAttemptedAtMs: Date.now(),
        sending: false,
        controller: new AbortController(),
        settleDeferredTerminalHook: () =>
          new Promise((resolve) => {
            finishHook = resolve;
          }),
      } as never);
      await loop.start();
      transport.deliver({ type: "host:registered", hostId: config.hostId, protocolVersion: 7 });
      transport.deliver({
        type: "session:status-acknowledged",
        sessionId: "lost",
        attemptId: "attempt",
        retryAccepted: false,
      });
      await waitFor(() => finishHook !== undefined);
      transport.deliver(assignment("other-session", "wt-2"));
      await flushMacrotask();
      expect(started).toEqual([]);
      expect(lines).toContain("session capacity reached: refused assign other-session");
      finishHook();
      await waitFor(() => pendingTerminalStatusOf(loop).size === 0);
      loop.stop();
    } finally {
      cleanup();
    }
  });
});
