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

describe("DaemonLoop terminal-hook overlap", () => {
  it("shares an acknowledged terminal settlement with an overlapping handoff", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const sent: HostToServerMessage[] = [];
      const transport = createLoopbackTransport({
        sendToServer: (message) => void sent.push(message),
      });
      const loop = new DaemonLoop({ config, transport });
      await loop.start();
      transport.deliver({ type: "host:registered", hostId: config.hostId, protocolVersion: 7 });
      const dispositions: boolean[] = [];
      let hookStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        hookStarted = resolve;
      });
      let finishHook!: () => void;
      const blocked = new Promise<void>((resolve) => {
        finishHook = resolve;
      });
      pendingTerminalStatusOf(loop).set("lost\0attempt", {
        message: {
          ...terminalStatusFixture,
          sessionId: "lost",
          attemptId: "attempt",
          errorCode: "checkout_fetch_failed",
        },
        firstAttemptedAtMs: Date.now(),
        sending: false,
        controller: new AbortController(),
        settleDeferredTerminalHook: async (runHook: boolean) => {
          dispositions.push(runHook);
          hookStarted();
          await blocked;
          return { summary: "after hook", summarySource: "harness" as const };
        },
      } as never);
      const expiresAt = new Date(Date.now() + 60_000).toISOString();

      transport.deliver({
        type: "session:status-acknowledged",
        sessionId: "lost",
        attemptId: "attempt",
        retryAccepted: false,
        terminalHookHandoffId: "replacement",
        terminalHookHandoffExpiresAt: expiresAt,
      });
      await started;
      transport.deliver({
        type: "session:terminal-hook",
        handoffId: "replacement",
        sessionId: "lost",
        repositoryId: "demo",
        worktreeId: "wt-1",
        status: "failed",
        expiresAt,
        errorCode: "checkout_fetch_failed",
      });
      await flushMacrotask();
      expect(dispositions).toEqual([true]);

      finishHook();
      await waitFor(() =>
        sent.some(
          (message) =>
            message.type === "session:terminal-hook-complete" &&
            message.handoffId === "replacement",
        ),
      );
      expect(
        sent.filter(
          (message) =>
            message.type === "session:terminal-hook-complete" &&
            message.handoffId === "replacement",
        ),
      ).toHaveLength(1);
      expect(pendingTerminalStatusOf(loop).has("lost\0attempt")).toBe(false);
      loop.stop();
    } finally {
      cleanup();
    }
  });

  it("fences replacement retries while same-process reconciliation is pending", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const sent: HostToServerMessage[] = [];
      const transport = createLoopbackTransport({
        sendToServer: (message) => void sent.push(message),
      });
      const loop = new DaemonLoop({ config, transport });
      await loop.start();
      transport.deliver({ type: "host:registered", hostId: config.hostId, protocolVersion: 7 });

      let finishHook!: () => void;
      const hookBlocked = new Promise<void>((resolve) => {
        finishHook = resolve;
      });
      const originalHookStarted = vi.fn();
      const replacementHookStarted = vi.fn();
      pendingTerminalStatusOf(loop).set("lost\0attempt", {
        message: {
          ...terminalStatusFixture,
          sessionId: "lost",
          attemptId: "attempt",
          errorCode: "checkout_fetch_failed",
        },
        firstAttemptedAtMs: Date.now(),
        sending: false,
        controller: new AbortController(),
        settleDeferredTerminalHook: async (runHook: boolean) => {
          if (!runHook) return undefined;
          originalHookStarted();
          await hookBlocked;
          return { summary: "after hook", summarySource: "harness" as const };
        },
      } as never);
      (
        loop as unknown as {
          processRunner: { run: (options: { argv: string[] }) => Promise<unknown> };
        }
      ).processRunner = {
        run: async (options) => {
          if (options.argv[0] === "/bin/sh") replacementHookStarted();
          return { exitCode: 0, timedOut: false, signal: null };
        },
      };

      const expiresAt = new Date(Date.now() + 60_000).toISOString();
      transport.deliver({
        type: "session:terminal-hook",
        handoffId: "replacement",
        sessionId: "lost",
        repositoryId: "demo",
        worktreeId: "wt-1",
        status: "failed",
        expiresAt,
        errorCode: "checkout_fetch_failed",
      });
      await waitFor(() => originalHookStarted.mock.calls.length === 1);

      // The keepalive retry must not mistake the visible, non-executing handoff
      // for an unstarted replacement while its same-process owner is settling.
      await loop.keepalive();
      expect(replacementHookStarted).not.toHaveBeenCalled();

      finishHook();
      await waitFor(() =>
        sent.some(
          (message) =>
            message.type === "session:terminal-hook-complete" &&
            message.handoffId === "replacement",
        ),
      );
      expect(
        sent.filter(
          (message) =>
            message.type === "session:terminal-hook-complete" &&
            message.handoffId === "replacement",
        ),
      ).toHaveLength(1);
      expect(replacementHookStarted).not.toHaveBeenCalled();
      loop.stop();
    } finally {
      cleanup();
    }
  });
});
