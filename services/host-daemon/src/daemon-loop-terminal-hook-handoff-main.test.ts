import { describe, expect, it, vi } from "vitest";

import type { HostToServerMessage } from "@auto-harness/shared";

import { DaemonLoop, createLoopbackTransport } from "./daemon-loop.ts";
import { flushMacrotask, makeRepo } from "../test-helpers/daemon-loop-test-helpers.ts";

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await flushMacrotask();
  }
  throw new Error("condition did not become true");
}

describe("DaemonLoop main-checkout terminal-hook handoffs", () => {
  it("claims and releases the main checkout for a scheduled session", async () => {
    const { config, cleanup, root } = await makeRepo();
    try {
      const sent: HostToServerMessage[] = [];
      const transport = createLoopbackTransport({
        sendToServer: (message) => void sent.push(message),
      });
      const loop = new DaemonLoop({ config, transport });
      await loop.start();
      const run = vi.fn(async () => ({ exitCode: 0 }));
      (loop as unknown as { processRunner: { run: typeof run } }).processRunner = { run };
      transport.deliver({ type: "host:registered", hostId: config.hostId, protocolVersion: 5 });
      transport.deliver({
        type: "session:terminal-hook",
        handoffId: "main-handoff",
        sessionId: "scheduled",
        repositoryId: "demo",
        worktreeId: null,
        status: "failed",
        errorCode: "host_lost",
      });
      await waitFor(() =>
        sent.some(
          (message) =>
            message.type === "session:terminal-hook-complete" &&
            message.handoffId === "main-handoff",
        ),
      );
      expect(run).toHaveBeenCalledWith(expect.objectContaining({ cwd: `${root}/repo` }));
      loop.stop();
    } finally {
      cleanup();
    }
  });

  it("settles a handoff when its main checkout cannot be claimed", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const sent: HostToServerMessage[] = [];
      const logs: string[] = [];
      const transport = createLoopbackTransport({
        sendToServer: (message) => void sent.push(message),
      });
      const loop = new DaemonLoop({ config, transport, onLog: (line) => void logs.push(line) });
      await loop.start();
      const worktrees = (loop as unknown as { worktrees: { acquireMain(): Promise<boolean> } })
        .worktrees;
      worktrees.acquireMain = async () => false;
      transport.deliver({ type: "host:registered", hostId: config.hostId, protocolVersion: 5 });
      transport.deliver({
        type: "session:terminal-hook",
        handoffId: "unavailable-main",
        sessionId: "scheduled",
        repositoryId: "demo",
        worktreeId: null,
        status: "failed",
        errorCode: "host_lost",
      });
      await waitFor(() =>
        sent.some(
          (message) =>
            message.type === "session:terminal-hook-complete" &&
            message.handoffId === "unavailable-main",
        ),
      );
      expect(logs).toContain(
        "terminal hook handoff failed for scheduled: main checkout unavailable for terminal hook scheduled",
      );
      loop.stop();
    } finally {
      cleanup();
    }
  });
});
