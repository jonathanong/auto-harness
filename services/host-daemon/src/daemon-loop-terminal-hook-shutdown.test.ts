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

describe("DaemonLoop terminal-hook shutdown", () => {
  it("keeps graceful shutdown alive through a handoff hook and its completion write", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      let finishHook!: (result: { exitCode: number }) => void;
      let finishCompletionSend!: () => void;
      const hookStarted = vi.fn();
      const completionSent = vi.fn();
      const transport = createLoopbackTransport({
        sendToServer: (message) => {
          if (message.type !== "session:terminal-hook-complete") return;
          completionSent();
          return new Promise<void>((resolve) => {
            finishCompletionSend = resolve;
          });
        },
      });
      const loop = new DaemonLoop({ config, transport });
      await loop.start();
      (
        loop as unknown as { processRunner: { run(): Promise<{ exitCode: number }> } }
      ).processRunner = {
        run: (options: { argv: string[] }) => {
          if (options.argv[0] !== "/bin/sh") return Promise.resolve({ exitCode: 0 });
          hookStarted();
          return new Promise((resolve) => {
            finishHook = resolve;
          });
        },
      };
      transport.deliver({ type: "host:registered", hostId: config.hostId, protocolVersion: 7 });
      transport.deliver({
        type: "session:terminal-hook",
        handoffId: "shutdown-handoff",
        sessionId: "lost",
        repositoryId: "demo",
        worktreeId: "wt-1",
        status: "failed",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        errorCode: "host_lost",
      });
      await waitFor(() => hookStarted.mock.calls.length === 1);

      let idle = false;
      const waiting = loop.waitForIdle().then(() => {
        idle = true;
      });
      await flushMacrotask();
      expect(idle).toBe(false);

      finishHook({ exitCode: 0 });
      await waitFor(() => completionSent.mock.calls.length === 1);
      await flushMacrotask();
      expect(idle).toBe(false);

      finishCompletionSend();
      await waiting;
      expect(idle).toBe(true);
      loop.stop();
    } finally {
      cleanup();
    }
  });
});
