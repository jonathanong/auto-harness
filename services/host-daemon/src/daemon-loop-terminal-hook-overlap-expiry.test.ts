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

describe("DaemonLoop terminal-hook overlap expiry", () => {
  it("bounds overlapping deferred settlement by the incoming handoff expiry", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const sent: HostToServerMessage[] = [];
      const transport = createLoopbackTransport({
        sendToServer: (message) => void sent.push(message),
      });
      const loop = new DaemonLoop({ config, transport });
      await loop.start();
      transport.deliver({ type: "host:registered", hostId: config.hostId, protocolVersion: 7 });

      const deadlines: number[] = [];
      let ranPastExpiry = false;
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
        settleDeferredTerminalHook: async (runHook: boolean, deadlineAtMs?: number) => {
          if (deadlineAtMs !== undefined) deadlines.push(deadlineAtMs);
          if (!runHook) return undefined;
          hookStarted();
          await blocked;
          if (deadlineAtMs !== undefined && deadlineAtMs <= Date.now()) return undefined;
          ranPastExpiry = true;
          return { summary: "after hook", summarySource: "harness" as const };
        },
      } as never);
      const expiresAtMs = Date.now() + 60_000;
      const expiresAt = new Date(expiresAtMs).toISOString();

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
      await started;
      expect(deadlines).toEqual([expiresAtMs]);
      const now = vi.spyOn(Date, "now").mockReturnValue(expiresAtMs);
      try {
        finishHook();
        await waitFor(() =>
          sent.some(
            (message) =>
              message.type === "session:terminal-hook-complete" &&
              message.handoffId === "replacement",
          ),
        );
      } finally {
        now.mockRestore();
      }
      expect(ranPastExpiry).toBe(false);
      expect(
        sent.find(
          (message) =>
            message.type === "session:terminal-hook-complete" &&
            message.handoffId === "replacement",
        ),
      ).toMatchObject({ type: "session:terminal-hook-complete", handoffId: "replacement" });
      loop.stop();
    } finally {
      cleanup();
    }
  });
});
