/* eslint-disable max-lines -- keepalive retry, ack, and primitive-failure cases share one loop fixture. */
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
} from "../test-helpers/daemon-loop-test-helpers.ts";

function replacementAssignment(attemptId: string) {
  return {
    type: "session:assign" as const,
    sessionId: "replaced",
    attemptId,
    repositoryId: "demo",
    prompt: "hello",
    resolvedArgv: ["printf", "%s", "hello"],
    timeout: 30,
    worktreeId: "wt-1",
    assignedAt: new Date().toISOString(),
  };
}

describe("DaemonLoop terminal status retry", () => {
  it("runs a deferred fetch hook only for a terminal retry disposition", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const transport = createLoopbackTransport({ sendToServer: () => undefined });
      const loop = new DaemonLoop({ config, transport });
      await loop.start();
      let hooks = 0;
      const pending = pendingTerminalStatusOf(loop);
      const deferred = () => Promise.resolve().then(() => void (hooks += 1));

      pending.set("fetch\0attempt-retried", {
        message: { ...statusMessage, sessionId: "fetch", attemptId: "attempt-retried" },
        firstAttemptedAtMs: Date.now(),
        sending: false,
        controller: new AbortController(),
        settleDeferredTerminalHook: async (runHook) => {
          if (runHook) await deferred();
        },
      });
      transport.deliver({
        type: "session:status-acknowledged",
        sessionId: "fetch",
        attemptId: "attempt-retried",
        retryAccepted: true,
      });
      await flushMicrotasks();
      expect(hooks).toBe(0);
      expect(pending.size).toBe(0);

      pending.set("fetch\0attempt-terminal", {
        message: { ...statusMessage, sessionId: "fetch", attemptId: "attempt-terminal" },
        firstAttemptedAtMs: Date.now(),
        sending: false,
        controller: new AbortController(),
        settleDeferredTerminalHook: async (runHook) => {
          if (runHook) await deferred();
        },
      });
      const terminalAck = {
        type: "session:status-acknowledged" as const,
        sessionId: "fetch",
        attemptId: "attempt-terminal",
        retryAccepted: false,
      };
      transport.deliver(terminalAck);
      transport.deliver(terminalAck);
      await flushMicrotasks();
      expect(hooks).toBe(1);
      expect(pending.size).toBe(0);
      loop.stop();
    } finally {
      cleanup();
    }
  });

  it("handles a retry disposition acknowledged during the initial status send", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      let transport!: ReturnType<typeof createAcknowledgingLoopbackTransport>;
      transport = createAcknowledgingLoopbackTransport({
        sendToServer: (message) => {
          if (message.type === "session:status") {
            transport.deliver({
              type: "session:status-acknowledged",
              sessionId: message.sessionId,
              attemptId: message.attemptId,
              retryAccepted: true,
            });
          }
        },
      });
      const loop = new DaemonLoop({ config, transport });
      const dispositions: boolean[] = [];
      let settled = false;
      (
        loop as unknown as {
          runner: {
            run(): Promise<{
              status: "failed";
              exitCode: null;
              logs: [];
              errorCode: "checkout_fetch_failed";
              settleDeferredTerminalHook: (runHook: boolean) => Promise<void>;
            }>;
          };
        }
      ).runner = {
        async run() {
          return {
            status: "failed",
            exitCode: null,
            logs: [],
            errorCode: "checkout_fetch_failed",
            settleDeferredTerminalHook: async (runHook) => {
              if (settled) return;
              settled = true;
              dispositions.push(runHook);
            },
          };
        },
      };
      await loop.start();
      transport.deliver({ type: "host:registered", hostId: config.hostId, protocolVersion: 4 });
      transport.deliver({
        ...replacementAssignment("attempt-immediate-status-ack"),
        sessionId: "immediate-status-ack",
      });
      await loop.waitForIdle();

      expect(dispositions).toEqual([false]);
      expect(pendingTerminalStatusOf(loop).size).toBe(0);
      loop.stop();
    } finally {
      cleanup();
    }
  });

  it("serializes another session on the retained worktree until its retry disposition", async () => {
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
      const dispositions: boolean[] = [];
      (
        loop as unknown as {
          runner: {
            run(assign: { sessionId: string }): Promise<{
              status: "completed" | "failed";
              exitCode: number | null;
              logs: [];
              errorCode?: string;
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
              settleDeferredTerminalHook: async (runHook) => {
                dispositions.push(runHook);
              },
            };
          }
          return { status: "completed", exitCode: 0, logs: [] };
        },
      };
      await loop.start();
      transport.deliver({ type: "host:registered", hostId: config.hostId, protocolVersion: 4 });

      transport.deliver({
        type: "session:assign",
        sessionId: "checkout-failure",
        attemptId: "attempt-checkout-failure",
        repositoryId: "demo",
        prompt: "first",
        resolvedArgv: ["printf", "%s", "first"],
        timeout: 30,
        worktreeId: "wt-1",
        assignedAt: new Date().toISOString(),
      });
      await flushMacrotask();
      expect(started).toEqual(["checkout-failure"]);
      expect(
        sent.some(
          (message) =>
            message.type === "session:status" && message.sessionId === "checkout-failure",
        ),
      ).toBe(true);

      transport.deliver({
        type: "session:assign",
        sessionId: "other-session",
        attemptId: "attempt-other-session",
        repositoryId: "demo",
        prompt: "second",
        resolvedArgv: ["printf", "%s", "second"],
        timeout: 30,
        worktreeId: "wt-1",
        assignedAt: new Date().toISOString(),
      });
      await flushMacrotask();
      expect(started).toEqual(["checkout-failure"]);

      transport.deliver({
        type: "session:status-acknowledged",
        sessionId: "checkout-failure",
        attemptId: "attempt-checkout-failure",
        retryAccepted: true,
      });
      await loop.waitForIdle();
      expect(dispositions).toEqual([false]);
      expect(started).toEqual(["checkout-failure", "other-session"]);
      loop.stop();
    } finally {
      cleanup();
    }
  });

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

  it("drops an older terminal report when its replacement assignment arrives before the status ACK", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const transport = createAcknowledgingLoopbackTransport({ sendToServer: () => undefined });
      const loop = new DaemonLoop({ config, transport });
      let start!: () => void;
      let runnerStarted = false;
      const started = new Promise<void>((resolve) => {
        start = resolve;
      });
      let finish!: () => void;
      const finished = new Promise<void>((resolve) => {
        finish = resolve;
      });
      (
        loop as unknown as {
          runner: {
            run(): Promise<{ status: "completed"; exitCode: number; logs: [] }>;
          };
        }
      ).runner = {
        async run() {
          runnerStarted = true;
          start();
          await finished;
          return { status: "completed", exitCode: 0, logs: [] };
        },
      };
      await loop.start();

      const oldStatusController = new AbortController();
      const supersededDispositions: boolean[] = [];
      let settleSuperseded!: () => void;
      const supersededSettled = new Promise<void>((resolve) => {
        settleSuperseded = resolve;
      });
      pendingTerminalStatusOf(loop).set("done-session\0attempt-old", {
        message: { ...statusMessage, attemptId: "attempt-old" },
        firstAttemptedAtMs: Date.now(),
        sending: false,
        controller: oldStatusController,
        settleDeferredTerminalHook: async (runHook) => {
          supersededDispositions.push(runHook);
          await supersededSettled;
        },
      });
      pendingTerminalStatusOf(loop).set("ordinary\0attempt-ordinary", {
        message: {
          ...statusMessage,
          sessionId: "ordinary",
          attemptId: "attempt-ordinary",
        },
        firstAttemptedAtMs: Date.now() - 2000,
        sending: false,
        controller: new AbortController(),
      });
      pendingTerminalStatusOf(loop).set("done-session\0attempt-unhooked", {
        message: { ...statusMessage, attemptId: "attempt-unhooked" },
        firstAttemptedAtMs: Date.now(),
        sending: false,
        controller: new AbortController(),
      });
      transport.deliver({
        type: "session:assign",
        sessionId: "done-session",
        attemptId: "attempt-replacement",
        repositoryId: "demo",
        prompt: "hello",
        resolvedArgv: ["printf", "%s", "hello"],
        timeout: 30,
        worktreeId: "wt-1",
        assignedAt: new Date().toISOString(),
      });

      await flushMicrotasks();
      expect(loop.inflightCount()).toBe(1);
      expect(pendingTerminalStatusOf(loop).has("done-session\0attempt-old")).toBe(false);
      expect(oldStatusController.signal.aborted).toBe(true);
      expect(supersededDispositions).toEqual([false]);
      expect(runnerStarted).toBe(false);

      settleSuperseded();
      await started;
      expect(loop.inflightCount()).toBe(1);

      finish();
      await loop.waitForIdle();
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
            if (statusAttempts === 1) throw "primitive send failed";
            if (statusAttempts === 2) throw new Error(`send failed #${String(statusAttempts)}`);
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
        lines.some((line) =>
          line.includes(
            "session:status send failed for flaky-status, will retry via keepalive: primitive send failed",
          ),
        ),
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
      const dispositions: boolean[] = [];
      pendingTerminalStatusOf(loop).set("done-session\0attempt-1", {
        message: statusMessage,
        firstAttemptedAtMs: Date.now() - 2000,
        sending: false,
        controller,
        settleDeferredTerminalHook: async (runHook) => {
          dispositions.push(runHook);
        },
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
      expect(dispositions).toEqual([true]);

      loop.stop();
    } finally {
      cleanup();
    }
  });

  it("fails closed and settles deferred hooks when stopping", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const loop = new DaemonLoop({
        config,
        transport: createLoopbackTransport({ sendToServer: () => undefined }),
      });
      await loop.start();
      const dispositions: boolean[] = [];
      let resolved = false;
      const controller = new AbortController();
      pendingTerminalStatusOf(loop).set("done-session\0attempt-1", {
        message: statusMessage,
        firstAttemptedAtMs: Date.now(),
        sending: false,
        controller,
        settleDeferredTerminalHook: async (runHook) => {
          dispositions.push(runHook);
        },
        resolveDeferredDisposition: () => {
          resolved = true;
        },
      });

      loop.stop();
      await flushMicrotasks();
      expect(dispositions).toEqual([true]);
      expect(resolved).toBe(true);
      expect(controller.signal.aborted).toBe(true);
      expect(pendingTerminalStatusOf(loop).size).toBe(0);
    } finally {
      cleanup();
    }
  });

  it("fails closed when active work becomes deferred after shutdown preparation", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const sent: HostToServerMessage[] = [];
      const transport = createAcknowledgingLoopbackTransport({
        sendToServer: (message) => void sent.push(message),
      });
      const loop = new DaemonLoop({ config, transport });
      const dispositions: boolean[] = [];
      let finish!: () => void;
      const finishing = new Promise<void>((resolve) => {
        finish = resolve;
      });
      (
        loop as unknown as {
          runner: {
            run(): Promise<{
              status: "failed";
              exitCode: null;
              logs: [];
              errorCode: "checkout_fetch_failed";
              settleDeferredTerminalHook: (runHook: boolean) => Promise<{
                summary: string;
                summarySource: "harness";
              }>;
            }>;
          };
        }
      ).runner = {
        async run() {
          await finishing;
          return {
            status: "failed",
            exitCode: null,
            logs: [],
            errorCode: "checkout_fetch_failed",
            settleDeferredTerminalHook: async (runHook) => {
              dispositions.push(runHook);
              return { summary: "after shutdown hook", summarySource: "harness" };
            },
          };
        },
      };
      await loop.start();
      transport.deliver({ type: "host:registered", hostId: config.hostId, protocolVersion: 6 });
      transport.deliver({
        type: "session:assign",
        sessionId: "finishing-during-shutdown",
        attemptId: "attempt-1",
        repositoryId: "demo",
        prompt: "hello",
        resolvedArgv: ["printf", "%s", "hello"],
        timeout: 30,
        worktreeId: "wt-1",
        assignedAt: new Date().toISOString(),
      });
      await flushMacrotask();

      loop.prepareForShutdown();
      finish();
      await loop.waitForIdle();

      expect(dispositions).toEqual([true]);
      expect(pendingTerminalStatusOf(loop).size).toBe(1);
      expect(sent).toContainEqual(
        expect.objectContaining({
          type: "session:status",
          errorCode: "setup_failed",
          result: { summary: "after shutdown hook", summarySource: "harness" },
        }),
      );
      const reported = sent.find(
        (message): message is Extract<HostToServerMessage, { type: "session:status" }> =>
          message.type === "session:status" && message.sessionId === "finishing-during-shutdown",
      );
      expect(reported).not.toHaveProperty("deferTerminalHookResult");
      loop.stop();
    } finally {
      cleanup();
    }
  });

  it("clears every pending terminal status for a session when the ack omits attemptId", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const transport = createLoopbackTransport({ sendToServer: () => undefined });
      const loop = new DaemonLoop({ config, transport, now: () => "now" });
      await loop.start();
      pendingTerminalStatusOf(loop).set("done-session\0attempt-1", {
        message: statusMessage,
        firstAttemptedAtMs: Date.now(),
        sending: false,
        controller: new AbortController(),
      });
      pendingTerminalStatusOf(loop).set("done-session\0attempt-2", {
        message: { ...statusMessage, attemptId: "attempt-2" },
        firstAttemptedAtMs: Date.now(),
        sending: false,
        controller: new AbortController(),
      });
      transport.deliver({ type: "session:status-acknowledged", sessionId: "done-session" });
      expect(pendingTerminalStatusOf(loop).size).toBe(0);
      loop.stop();
    } finally {
      cleanup();
    }
  });

  it("leaves pending terminal statuses for other sessions when an ack omits attemptId", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const transport = createLoopbackTransport({ sendToServer: () => undefined });
      const loop = new DaemonLoop({ config, transport, now: () => "now" });
      await loop.start();
      pendingTerminalStatusOf(loop).set("done-session\0attempt-1", {
        message: statusMessage,
        firstAttemptedAtMs: Date.now(),
        sending: false,
        controller: new AbortController(),
      });
      pendingTerminalStatusOf(loop).set("other-session\0attempt-1", {
        message: { ...statusMessage, sessionId: "other-session" },
        firstAttemptedAtMs: Date.now(),
        sending: false,
        controller: new AbortController(),
      });
      transport.deliver({ type: "session:status-acknowledged", sessionId: "done-session" });
      expect([...pendingTerminalStatusOf(loop).keys()]).toEqual(["other-session\0attempt-1"]);
      loop.stop();
    } finally {
      cleanup();
    }
  });

  it("awaits a deferred disposition when an ACK omits attemptId", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const transport = createLoopbackTransport({ sendToServer: () => undefined });
      const loop = new DaemonLoop({ config, transport });
      await loop.start();
      const dispositions: boolean[] = [];
      pendingTerminalStatusOf(loop).set("done-session\0attempt-1", {
        message: statusMessage,
        firstAttemptedAtMs: Date.now(),
        sending: false,
        controller: new AbortController(),
        settleDeferredTerminalHook: async (runHook) => {
          dispositions.push(runHook);
        },
      });
      transport.deliver({ type: "session:status-acknowledged", sessionId: "done-session" });
      await flushMicrotasks();
      expect(dispositions).toEqual([true]);
      expect(pendingTerminalStatusOf(loop).size).toBe(0);
      loop.stop();
    } finally {
      cleanup();
    }
  });

  it("acknowledges before a retained v4 target fence and keeps it through a cancelled waiter", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const sent: HostToServerMessage[] = [];
      const transport = createAcknowledgingLoopbackTransport({
        sendToServer: (message) => void sent.push(message),
      });
      const loop = new DaemonLoop({ config, transport });
      const runs: string[] = [];
      (
        loop as unknown as {
          runner: {
            run(assign: { sessionId: string }): Promise<{
              status: "completed" | "failed";
              exitCode: 0 | null;
              logs: [];
              errorCode?: "checkout_fetch_failed";
              settleDeferredTerminalHook?: (runHook: boolean) => Promise<void>;
            }>;
          };
        }
      ).runner = {
        async run(assign) {
          runs.push(assign.sessionId);
          if (assign.sessionId === "retained") {
            return {
              status: "failed",
              exitCode: null,
              logs: [],
              errorCode: "checkout_fetch_failed",
              settleDeferredTerminalHook: async () => undefined,
            };
          }
          return { status: "completed", exitCode: 0, logs: [] };
        },
      };
      await loop.start();
      transport.deliver({ type: "host:registered", hostId: config.hostId, protocolVersion: 4 });

      transport.deliver({
        ...replacementAssignment("attempt-retained"),
        sessionId: "retained",
      });
      await flushMacrotask();
      expect(runs).toEqual(["retained"]);

      transport.deliver({
        ...replacementAssignment("attempt-waiting"),
        sessionId: "waiting",
      });
      await flushMacrotask();
      expect(runs).toEqual(["retained"]);
      expect(sent).toContainEqual(
        expect.objectContaining({
          type: "session:ack",
          sessionId: "waiting",
          attemptId: "attempt-waiting",
        }),
      );

      transport.deliver({
        type: "session:cancel",
        sessionId: "waiting",
        attemptId: "attempt-waiting",
      });
      await flushMacrotask();
      expect(loop.inflightCount()).toBe(1);

      transport.deliver({
        ...replacementAssignment("attempt-after-cancel"),
        sessionId: "after-cancel",
      });
      await flushMacrotask();
      expect(runs).toEqual(["retained"]);

      transport.deliver({
        type: "session:status-acknowledged",
        sessionId: "retained",
        attemptId: "attempt-retained",
        retryAccepted: true,
      });
      await loop.waitForIdle();

      expect(runs).toEqual(["retained", "after-cancel"]);
      loop.stop();
    } finally {
      cleanup();
    }
  });

  it("logs a primitive terminal-status retry failure", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const lines: string[] = [];
      const transport = createLoopbackTransport({
        sendToServer: (message) => {
          if (message.type === "session:status") return Promise.reject("wire down");
          return undefined;
        },
      });
      const loop = new DaemonLoop({
        config,
        transport,
        now: () => "now",
        onLog: (line) => lines.push(line),
      });
      await loop.start();
      pendingTerminalStatusOf(loop).set("done-session\0attempt-1", {
        message: statusMessage,
        firstAttemptedAtMs: Date.now(),
        sending: false,
        controller: new AbortController(),
      });
      await loop.keepalive();
      await flushMicrotasks();
      expect(lines.some((line) => line.includes("wire down"))).toBe(true);
      loop.stop();
    } finally {
      cleanup();
    }
  });
});
