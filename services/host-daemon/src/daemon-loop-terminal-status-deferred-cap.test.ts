import { describe, expect, it } from "vitest";

import type { HostToServerMessage } from "@auto-harness/shared";

import { DaemonLoop } from "./daemon-loop.ts";
import {
  createAcknowledgingLoopbackTransport,
  flushMacrotask,
  makeRepo,
  pendingTerminalStatusOf,
  terminalStatusFixture as statusMessage,
} from "../test-helpers/daemon-loop-test-helpers.ts";

describe("DaemonLoop deferred terminal status capacity", () => {
  it("retains a deferred checkout disposition beyond the ordinary retry buffer cap", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const sent: HostToServerMessage[] = [];
      const transport = createAcknowledgingLoopbackTransport({
        sendToServer: (message) => void sent.push(message),
      });
      const loop = new DaemonLoop({
        config,
        transport,
        pendingStatusMaxCount: 1,
        executionProfiles: { maxConcurrentAssignments: 1, profiles: new Map() },
      });
      const dispositions: boolean[] = [];
      const runSessions: string[] = [];
      let deferred = false;
      (
        loop as unknown as {
          runner: {
            run(
              assign: { sessionId: string },
              options: { deferCheckoutFetchFailureHook: boolean },
            ): Promise<{
              status: "failed";
              exitCode: null;
              logs: [];
              errorCode: "checkout_fetch_failed";
              settleDeferredTerminalHook: (runHook: boolean) => Promise<void>;
            }>;
          };
        }
      ).runner = {
        async run(assign, options) {
          runSessions.push(assign.sessionId);
          deferred = options.deferCheckoutFetchFailureHook;
          return {
            status: "failed",
            exitCode: null,
            logs: [],
            errorCode: "checkout_fetch_failed",
            settleDeferredTerminalHook: async (runHook) => {
              dispositions.push(runHook);
            },
          };
        },
      };
      await loop.start();
      transport.deliver({ type: "host:registered", hostId: config.hostId, protocolVersion: 6 });
      pendingTerminalStatusOf(loop).set("older\0attempt-older", {
        message: { ...statusMessage, sessionId: "older", attemptId: "attempt-older" },
        firstAttemptedAtMs: Date.now(),
        sending: false,
        controller: new AbortController(),
      });

      transport.deliver({
        type: "session:assign",
        sessionId: "fetch-failure",
        repositoryId: "demo",
        prompt: "hello",
        resolvedArgv: ["printf", "%s", "hello"],
        timeout: 30,
        worktreeId: "wt-1",
        attemptId: "attempt-fetch-failure",
        assignedAt: new Date().toISOString(),
      });
      await flushMacrotask();

      expect(deferred).toBe(true);
      expect(dispositions).toEqual([]);
      expect(pendingTerminalStatusOf(loop).size).toBe(2);
      expect(
        sent.some(
          (message) => message.type === "session:status" && message.sessionId === "fetch-failure",
        ),
      ).toBe(true);

      transport.deliver({
        type: "session:assign",
        sessionId: "beyond-reserved-capacity",
        repositoryId: "demo",
        prompt: "later",
        resolvedArgv: ["printf", "%s", "later"],
        timeout: 30,
        worktreeId: "wt-1",
        attemptId: "attempt-beyond-capacity",
        assignedAt: new Date().toISOString(),
      });
      await flushMacrotask();
      expect(runSessions).toEqual(["fetch-failure"]);

      transport.deliver({
        type: "session:status-acknowledged",
        sessionId: "fetch-failure",
        attemptId: "attempt-fetch-failure",
        retryAccepted: true,
      });
      await loop.waitForIdle();
      expect(dispositions).toEqual([false]);
      loop.stop();
    } finally {
      cleanup();
    }
  });
});
