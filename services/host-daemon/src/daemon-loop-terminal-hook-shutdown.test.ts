/* eslint-disable max-lines -- shutdown races share one durable-handoff lifecycle fixture. */
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

  it("releases shutdown when a handoff expires behind earlier target work", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const logs: string[] = [];
      const transport = createLoopbackTransport({ sendToServer: () => undefined });
      const loop = new DaemonLoop({
        config,
        transport,
        onLog: (line) => logs.push(line),
      });
      await loop.start();
      const internals = loop as unknown as {
        worktreeAssignmentTails: Map<string, Promise<void>>;
        pendingTerminalHookHandoffs: Map<
          string,
          { executing: boolean; work?: Promise<void> | undefined }
        >;
      };
      let releaseEarlierWork!: () => void;
      const earlierWork = new Promise<void>((resolve) => {
        releaseEarlierWork = resolve;
      });
      internals.worktreeAssignmentTails.set("worktree\0demo\0wt-1", earlierWork);

      transport.deliver({ type: "host:registered", hostId: config.hostId, protocolVersion: 7 });
      transport.deliver({
        type: "session:terminal-hook",
        handoffId: "expired-waiter",
        sessionId: "lost",
        repositoryId: "demo",
        worktreeId: "wt-1",
        status: "failed",
        expiresAt: new Date(Date.now() + 25).toISOString(),
      });
      await waitFor(
        () => internals.pendingTerminalHookHandoffs.get("expired-waiter")?.executing === true,
      );

      let idle = false;
      const waiting = loop.waitForIdle().then(() => {
        idle = true;
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      releaseEarlierWork();
      await waiting;

      expect(idle).toBe(true);
      expect(internals.pendingTerminalHookHandoffs.has("expired-waiter")).toBe(false);
      expect(logs).toContainEqual(expect.stringContaining("at the control-plane expiry"));
      loop.stop();
    } finally {
      cleanup();
    }
  });

  it("leaves a handoff queued when shutdown starts behind earlier target work", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const sent: HostToServerMessage[] = [];
      const hookStarted = vi.fn();
      const transport = createLoopbackTransport({
        sendToServer: (message) => void sent.push(message),
      });
      const loop = new DaemonLoop({ config, transport });
      await loop.start();
      (
        loop as unknown as { processRunner: { run(): Promise<{ exitCode: number }> } }
      ).processRunner = {
        run: async () => {
          hookStarted();
          return { exitCode: 0 };
        },
      };
      const internals = loop as unknown as {
        worktreeAssignmentTails: Map<string, Promise<void>>;
        pendingTerminalHookHandoffs: Map<string, { executing: boolean }>;
      };
      let releaseEarlierWork!: () => void;
      const earlierWork = new Promise<void>((resolve) => {
        releaseEarlierWork = resolve;
      });
      internals.worktreeAssignmentTails.set("worktree\0demo\0wt-1", earlierWork);

      transport.deliver({ type: "host:registered", hostId: config.hostId, protocolVersion: 7 });
      transport.deliver({
        type: "session:terminal-hook",
        handoffId: "shutdown-waiter",
        sessionId: "lost",
        repositoryId: "demo",
        worktreeId: "wt-1",
        status: "failed",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      await waitFor(
        () => internals.pendingTerminalHookHandoffs.get("shutdown-waiter")?.executing === true,
      );

      loop.prepareForShutdown();
      releaseEarlierWork();
      await loop.waitForIdle();

      expect(hookStarted).not.toHaveBeenCalled();
      expect(sent).not.toContainEqual(
        expect.objectContaining({
          type: "session:terminal-hook-complete",
          handoffId: "shutdown-waiter",
        }),
      );
      expect(internals.pendingTerminalHookHandoffs.has("shutdown-waiter")).toBe(true);
      loop.stop();
    } finally {
      cleanup();
    }
  });

  it("does not wait for a buffered completion after the transport disconnects", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      let connected = true;
      let finishCompletionSend!: () => void;
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
      transport.isRegistered = () => connected;
      const loop = new DaemonLoop({ config, transport });
      await loop.start();
      (
        loop as unknown as { processRunner: { run(): Promise<{ exitCode: number }> } }
      ).processRunner = {
        run: async () => ({ exitCode: 0 }),
      };
      transport.deliver({ type: "host:registered", hostId: config.hostId, protocolVersion: 7 });
      transport.deliver({
        type: "session:terminal-hook",
        handoffId: "disconnected-completion",
        sessionId: "lost",
        repositoryId: "demo",
        worktreeId: "wt-1",
        status: "failed",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      await waitFor(() => completionSent.mock.calls.length === 1);

      connected = false;
      loop.prepareForShutdown();
      const waiting = loop.waitForIdle();
      let timeout!: ReturnType<typeof setTimeout>;
      const idle = await Promise.race([
        waiting.then(() => true),
        new Promise<boolean>((resolve) => {
          timeout = setTimeout(() => resolve(false), 100);
        }),
      ]);
      clearTimeout(timeout);
      expect(idle).toBe(true);

      finishCompletionSend();
      await waiting;
      loop.stop();
    } finally {
      cleanup();
    }
  });

  it("leaves queued durable handoffs for a replacement daemon during shutdown", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const hookStarted = vi.fn(async () => ({ exitCode: 0 }));
      const loop = new DaemonLoop({
        config,
        transport: createLoopbackTransport({ sendToServer: () => undefined }),
      });
      await loop.start();
      (
        loop as unknown as { processRunner: { run(): Promise<{ exitCode: number }> } }
      ).processRunner = { run: hookStarted };
      const pending = (
        loop as unknown as {
          pendingTerminalHookHandoffs: Map<string, object>;
        }
      ).pendingTerminalHookHandoffs;
      pending.set("queued-during-shutdown", {
        message: {
          type: "session:terminal-hook",
          handoffId: "queued-during-shutdown",
          sessionId: "lost",
          repositoryId: "demo",
          worktreeId: "wt-1",
          status: "failed",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
        expiresAtMs: Date.now() + 60_000,
        complete: false,
        executing: false,
        sending: false,
      });

      loop.prepareForShutdown();
      await loop.waitForIdle();

      expect(hookStarted).not.toHaveBeenCalled();
      expect(pending.has("queued-during-shutdown")).toBe(true);
      loop.stop();
    } finally {
      cleanup();
    }
  });
});
