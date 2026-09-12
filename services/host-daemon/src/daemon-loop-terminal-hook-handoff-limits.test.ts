import { describe, expect, it, vi } from "vitest";

import { DaemonLoop, createLoopbackTransport } from "./daemon-loop.ts";
import { flushMacrotask, makeRepo } from "../test-helpers/daemon-loop-test-helpers.ts";

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await flushMacrotask();
  }
  throw new Error("condition did not become true");
}

describe("DaemonLoop terminal-hook handoff limits", () => {
  it("expires an unacknowledged handoff at the server-aligned retention window", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const logs: string[] = [];
      const transport = createLoopbackTransport({ sendToServer: () => undefined });
      const loop = new DaemonLoop({
        config,
        transport,
        onLog: (line) => logs.push(line),
        pendingTerminalHookHandoffMaxAgeMs: -1,
      });
      await loop.start();
      transport.deliver({ type: "host:registered", hostId: config.hostId, protocolVersion: 5 });
      transport.deliver({
        type: "session:terminal-hook",
        handoffId: "old",
        sessionId: "old",
        repositoryId: "demo",
        worktreeId: "wt-1",
        status: "failed",
        errorCode: "host_lost",
      });
      await waitFor(
        () =>
          (loop as unknown as { pendingTerminalHookHandoffs: Map<string, unknown> })
            .pendingTerminalHookHandoffs.size === 1,
      );
      await loop.keepalive();
      expect(
        (loop as unknown as { pendingTerminalHookHandoffs: Map<string, unknown> })
          .pendingTerminalHookHandoffs.size,
      ).toBe(0);
      expect(logs).toContainEqual(expect.stringContaining("completion expired"));
      loop.stop();
    } finally {
      cleanup();
    }
  });

  it("refuses a handoff when its bounded completion buffer is full", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const logs: string[] = [];
      const transport = createLoopbackTransport({ sendToServer: () => undefined });
      const loop = new DaemonLoop({
        config,
        transport,
        onLog: (line) => logs.push(line),
        pendingTerminalHookHandoffMaxCount: 0,
      });
      await loop.start();
      transport.deliver({ type: "host:registered", hostId: config.hostId, protocolVersion: 5 });
      transport.deliver({
        type: "session:terminal-hook",
        handoffId: "full",
        sessionId: "full",
        repositoryId: "demo",
        worktreeId: "wt-1",
        status: "failed",
        errorCode: "host_lost",
      });
      await flushMacrotask();
      expect(logs).toContainEqual(expect.stringContaining("retry buffer full"));
      expect(
        (loop as unknown as { pendingTerminalHookHandoffs: Map<string, unknown> })
          .pendingTerminalHookHandoffs.size,
      ).toBe(0);
      loop.stop();
    } finally {
      cleanup();
    }
  });

  it("counts an active handoff against assignment capacity on another target", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const transport = createLoopbackTransport({ sendToServer: () => undefined });
      const loop = new DaemonLoop({ config, transport });
      await loop.start();
      transport.deliver({ type: "host:registered", hostId: config.hostId, protocolVersion: 5 });
      let finishHook!: (result: { exitCode: number }) => void;
      (
        loop as unknown as { processRunner: { run(): Promise<{ exitCode: number }> } }
      ).processRunner = {
        run: (options: { argv: string[] }) =>
          options.argv[0] === "/bin/sh"
            ? new Promise((resolve) => {
                finishHook = resolve;
              })
            : Promise.resolve({ exitCode: 0 }),
      };
      const assignmentStarted = vi.fn();
      (loop as unknown as { runAssign(): Promise<void> }).runAssign = async () => {
        assignmentStarted();
      };
      transport.deliver({
        type: "session:terminal-hook",
        handoffId: "capacity",
        sessionId: "lost",
        repositoryId: "demo",
        worktreeId: "wt-1",
        status: "failed",
        errorCode: "host_lost",
      });
      await waitFor(() => finishHook !== undefined);
      (loop as unknown as { serverProtocolVersion: number }).serverProtocolVersion = 0;
      transport.deliver({
        type: "session:assign",
        sessionId: "scheduled-next",
        attemptId: "attempt-scheduled-next",
        sessionType: "scheduled",
        repositoryId: "demo",
        prompt: "next",
        resolvedArgv: ["true"],
        timeout: 30,
        worktreeId: null,
        assignedAt: new Date().toISOString(),
      });
      await flushMacrotask();
      expect(assignmentStarted).not.toHaveBeenCalled();
      finishHook({ exitCode: 0 });
      await waitFor(
        () =>
          (loop as unknown as { activeTerminalHookHandoffs: number }).activeTerminalHookHandoffs ===
          0,
      );
      loop.stop();
    } finally {
      cleanup();
    }
  });
});
