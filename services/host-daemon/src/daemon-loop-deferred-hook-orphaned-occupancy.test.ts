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

type CheckoutFailureRunner = {
  run(assign: { sessionId: string }): Promise<{
    status: "failed" | "completed";
    exitCode: number | null;
    logs: [];
    errorCode?: "checkout_fetch_failed";
    settleDeferredTerminalHook?: (runHook: boolean) => Promise<void>;
  }>;
};

function installCheckoutFailureRunner(
  loop: DaemonLoop,
  started: string[],
  onHook: (finish: (error?: Error) => void) => void,
): void {
  (loop as unknown as { runner: CheckoutFailureRunner }).runner = {
    async run(assign) {
      started.push(assign.sessionId);
      if (assign.sessionId.startsWith("checkout-failure")) {
        return {
          status: "failed",
          exitCode: null,
          logs: [],
          errorCode: "checkout_fetch_failed",
          settleDeferredTerminalHook: () =>
            new Promise((resolve, reject) => {
              onHook((error) => (error ? reject(error) : resolve()));
            }),
        };
      }
      return { status: "completed", exitCode: 0, logs: [] };
    },
  };
}

describe("DaemonLoop orphaned deferred-hook occupancy", () => {
  it("holds capacity after drain resume with no matching inflight entry", async () => {
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
      installCheckoutFailureRunner(loop, started, (finish) => {
        finishHook = finish;
      });
      await loop.start();
      transport.deliver({ type: "host:registered", hostId: config.hostId, protocolVersion: 6 });
      transport.deliver(assignment("checkout-failure", "wt-1"));
      await waitFor(() =>
        sent.some(
          (message) =>
            message.type === "session:status" && message.sessionId === "checkout-failure",
        ),
      );

      loop.prepareForShutdown();
      await waitFor(
        () => (loop as unknown as { inflight: Map<string, unknown> }).inflight.size === 0,
      );
      await loop.resumeFromDrain();
      transport.deliver({ type: "host:registered", hostId: config.hostId, protocolVersion: 6 });
      transport.deliver({
        type: "session:status-acknowledged",
        sessionId: "checkout-failure",
        attemptId: "attempt-checkout-failure",
        retryAccepted: false,
      });
      await waitFor(() => finishHook !== undefined);
      expect(
        (loop as unknown as { hasSpareExecutionCapacity(): boolean }).hasSpareExecutionCapacity(),
      ).toBe(false);

      transport.deliver(assignment("other-session", "wt-2"));
      await flushMacrotask();
      expect(started).toEqual(["checkout-failure"]);
      expect(lines).toContain("session capacity reached: refused assign other-session");

      finishHook();
      await loop.waitForIdle();
      transport.deliver(assignment("after-resume", "wt-2"));
      await loop.waitForIdle();
      expect(started).toEqual(["checkout-failure", "after-resume"]);
      loop.stop();
    } finally {
      cleanup();
    }
  });

  it("holds capacity after abortInflight during deferred settlement", async () => {
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
      installCheckoutFailureRunner(loop, started, (finish) => {
        finishHook = finish;
      });
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
      for (const entry of (
        loop as unknown as { inflight: Map<string, { controller: AbortController }> }
      ).inflight.values()) {
        entry.controller.abort();
      }
      expect(
        (loop as unknown as { hasSpareExecutionCapacity(): boolean }).hasSpareExecutionCapacity(),
      ).toBe(false);

      transport.deliver(assignment("other-session", "wt-2"));
      await flushMacrotask();
      expect(started).toEqual(["checkout-failure"]);
      expect(lines).toContain("session capacity reached: refused assign other-session");

      finishHook();
      await loop.waitForIdle();
      transport.deliver(assignment("after-abort", "wt-2"));
      await loop.waitForIdle();
      expect(started).toEqual(["checkout-failure", "after-abort"]);
      loop.stop();
    } finally {
      cleanup();
    }
  });
});
