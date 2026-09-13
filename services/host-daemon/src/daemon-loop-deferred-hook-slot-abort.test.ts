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

describe("DaemonLoop deferred hook slot abort", () => {
  it("does not start a deferred hook when slot wait is aborted", async () => {
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
      let hookStarted = false;
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
          if (assign.sessionId === "checkout-failure") {
            return {
              status: "failed",
              exitCode: null,
              logs: [],
              errorCode: "checkout_fetch_failed",
              settleDeferredTerminalHook: async () => {
                hookStarted = true;
              },
            };
          }
          await new Promise<void>((resolve) => {
            finishOther = resolve;
          });
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
      transport.deliver(assignment("other-session", "wt-2"));
      await waitFor(() => finishOther !== undefined);
      transport.deliver({
        type: "session:status-acknowledged",
        sessionId: "checkout-failure",
        attemptId: "attempt-checkout-failure",
        retryAccepted: false,
      });
      await waitFor(
        () =>
          (loop as unknown as { executionCapacityWaiters: Set<unknown> }).executionCapacityWaiters
            .size === 1,
      );
      loop.stop();
      await flushMacrotask();
      await flushMacrotask();
      expect(hookStarted).toBe(false);
      finishOther();
    } finally {
      cleanup();
    }
  });
});
