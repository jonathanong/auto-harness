import { describe, expect, it, vi } from "vitest";

import type { HostToServerMessage } from "@auto-harness/shared";

import { DaemonLoop, createLoopbackTransport } from "./daemon-loop.ts";
import {
  flushMacrotask,
  makeRepo,
  pendingTerminalStatusOf,
  terminalStatusFixture,
} from "../test-helpers/daemon-loop-test-helpers.ts";

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await flushMacrotask();
  }
  throw new Error("condition did not become true");
}

describe("DaemonLoop terminal-hook handoff", () => {
  it("runs a v5 handoff once and retries its completion until acknowledged", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const sent: HostToServerMessage[] = [];
      const transport = createLoopbackTransport({
        sendToServer: (message) => void sent.push(message),
      });
      const loop = new DaemonLoop({ config, transport });
      await loop.start();
      // Startup uses real git; the handoff boundary itself is a pipe-based
      // child process and is isolated here so completion timing is explicit.
      const run = vi.fn(async () => ({ exitCode: 0 }));
      (loop as unknown as { processRunner: { run: typeof run } }).processRunner = {
        run,
      };
      transport.deliver({ type: "host:registered", hostId: config.hostId, protocolVersion: 5 });
      transport.deliver({
        type: "session:terminal-hook",
        handoffId: "handoff",
        sessionId: "lost",
        repositoryId: "demo",
        worktreeId: "wt-1",
        status: "failed",
        errorCode: "host_lost",
      });

      await waitFor(
        () =>
          sent.filter((message) => message.type === "session:terminal-hook-complete").length === 1,
      );
      expect(sent).toContainEqual({
        type: "session:terminal-hook-complete",
        sessionId: "lost",
        handoffId: "handoff",
      });
      const hookCalls = run.mock.calls.filter(([options]) => options.argv[0] === "/bin/sh");
      expect(hookCalls).toHaveLength(1);
      expect(run).toHaveBeenCalledWith(
        expect.objectContaining({
          argv: ["/bin/sh", config.repositories[0]!.terminalHookScript],
          env: expect.objectContaining({
            HARNESS_SESSION_ID: "lost",
            HARNESS_STATUS: "failed",
            HARNESS_ERROR_CODE: "host_lost",
          }),
        }),
      );
      await loop.keepalive();
      await waitFor(
        () =>
          sent.filter((message) => message.type === "session:terminal-hook-complete").length === 2,
      );

      transport.deliver({
        type: "session:terminal-hook-acknowledged",
        sessionId: "lost",
        handoffId: "handoff",
      });
      await flushMacrotask();
      expect(
        (loop as unknown as { pendingTerminalHookHandoffs: Map<string, unknown> })
          .pendingTerminalHookHandoffs.size,
      ).toBe(0);
      loop.stop();
    } finally {
      cleanup();
    }
  });

  it("settles a same-process terminal owner without running the replacement hook twice", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const sent: HostToServerMessage[] = [];
      const transport = createLoopbackTransport({
        sendToServer: (message) => void sent.push(message),
      });
      const loop = new DaemonLoop({ config, transport });
      await loop.start();
      transport.deliver({ type: "host:registered", hostId: config.hostId, protocolVersion: 6 });
      const dispositions: boolean[] = [];
      pendingTerminalStatusOf(loop).set("lost\\0attempt", {
        message: { ...terminalStatusFixture, sessionId: "lost", attemptId: "attempt" },
        firstAttemptedAtMs: Date.now(),
        sending: false,
        controller: new AbortController(),
        settleDeferredTerminalHook: async (runHook: boolean) => {
          dispositions.push(runHook);
          return { summary: "after hook", summarySource: "harness" as const };
        },
      } as never);

      transport.deliver({
        type: "session:terminal-hook",
        handoffId: "replacement",
        sessionId: "lost",
        repositoryId: "demo",
        worktreeId: "wt-1",
        status: "failed",
        errorCode: "host_lost",
      });
      await waitFor(() =>
        sent.some(
          (message) =>
            message.type === "session:terminal-hook-complete" &&
            message.handoffId === "replacement",
        ),
      );
      expect(dispositions).toEqual([true]);
      expect(sent).toContainEqual({
        type: "session:terminal-hook-complete",
        sessionId: "lost",
        handoffId: "replacement",
        result: { summary: "after hook", summarySource: "harness" },
      });
      // The original status remains until its independent durable ACK arrives.
      expect(pendingTerminalStatusOf(loop).has("lost\\0attempt")).toBe(true);
      loop.stop();
    } finally {
      cleanup();
    }
  });

  it("serializes a later assignment behind an in-progress handoff on the same worktree", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const transport = createLoopbackTransport({
        sendToServer: (message) => {
          if (message.type === "session:ack") {
            transport.deliver({
              type: "session:acknowledged",
              sessionId: message.sessionId,
              attemptId: message.attemptId,
            });
          }
        },
      });
      const loop = new DaemonLoop({ config, transport });
      await loop.start();
      transport.deliver({ type: "host:registered", hostId: config.hostId, protocolVersion: 5 });
      let finishHook!: (result: { exitCode: number }) => void;
      const hookStarted = vi.fn();
      (
        loop as unknown as { processRunner: { run(): Promise<{ exitCode: number }> } }
      ).processRunner = {
        run: (options: { argv: string[] }) => {
          if (options.argv[0] === "/bin/sh") {
            hookStarted();
            return new Promise((resolve) => {
              finishHook = resolve;
            });
          }
          return Promise.resolve({ exitCode: 0 });
        },
      };
      const assignmentStarted = vi.fn();
      (loop as unknown as { runAssign(): Promise<void> }).runAssign = async () => {
        assignmentStarted();
      };
      transport.deliver({
        type: "session:terminal-hook",
        handoffId: "handoff",
        sessionId: "lost",
        repositoryId: "demo",
        worktreeId: "wt-1",
        status: "failed",
        errorCode: "host_lost",
      });
      await waitFor(() => hookStarted.mock.calls.length === 1);
      // The v5 registration is enough for handoff admission. Use legacy
      // assignment acknowledgement here to isolate the physical-target fence.
      (loop as unknown as { serverProtocolVersion: number }).serverProtocolVersion = 0;
      transport.deliver({
        type: "session:assign",
        sessionId: "next",
        attemptId: "attempt-next",
        repositoryId: "demo",
        prompt: "next",
        resolvedArgv: ["true"],
        timeout: 30,
        worktreeId: "wt-1",
        assignedAt: new Date().toISOString(),
      });
      await flushMacrotask();
      expect(assignmentStarted).not.toHaveBeenCalled();
      finishHook({ exitCode: 0 });
      await waitFor(() => assignmentStarted.mock.calls.length === 1);
      loop.stop();
    } finally {
      cleanup();
    }
  });
});
