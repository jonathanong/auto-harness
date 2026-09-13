import { describe, expect, it } from "vitest";

import type { HostToServerMessage, HostWireMessage } from "@auto-harness/shared";

import { DaemonLoop, createLoopbackTransport } from "./daemon-loop.ts";
import {
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

describe("DaemonLoop orphaned deferred-hook occupancy wakeup", () => {
  it("wakes a parked assignment when an ACK-claimed orphaned settlement finishes", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const sent: HostToServerMessage[] = [];
      const transport = createLoopbackTransport({
        sendToServer: (message) => void sent.push(message),
      });
      const loop = new DaemonLoop({
        config,
        transport,
        executionProfiles: { maxConcurrentAssignments: 1, profiles: new Map() },
      });
      const started: string[] = [];
      let finishHook!: () => void;
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
      await loop.start();
      transport.deliver({ type: "host:registered", hostId: config.hostId, protocolVersion: 6 });
      transport.deliver(assignment("other-session", "wt-2"));
      await waitFor(() => sent.some((message) => message.type === "session:ack"));
      transport.deliver({
        type: "session:status-acknowledged",
        sessionId: "lost",
        attemptId: "attempt",
        retryAccepted: false,
      });
      await waitFor(() => finishHook !== undefined);
      transport.deliver({
        type: "session:acknowledged",
        sessionId: "other-session",
        attemptId: "attempt-other-session",
      });
      await waitFor(
        () =>
          (loop as unknown as { executionCapacityWaiters: Set<unknown> }).executionCapacityWaiters
            .size === 1,
      );
      expect(started).toEqual([]);
      finishHook();
      await waitFor(() => started.includes("other-session"));
      loop.stop();
    } finally {
      cleanup();
    }
  });
});
