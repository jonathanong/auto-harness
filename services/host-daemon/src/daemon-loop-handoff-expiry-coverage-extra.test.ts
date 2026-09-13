import { describe, expect, it } from "vitest";

import type { HostToServerMessage } from "@auto-harness/shared";
import { DaemonLoop, createLoopbackTransport } from "./daemon-loop.ts";
import { makeRepo, pendingTerminalStatusOf } from "../test-helpers/daemon-loop-test-helpers.ts";

type HandoffInternals = {
  pendingTerminalHookHandoffs: Map<string, unknown>;
  runTerminalHookHandoff(pending: object): Promise<void>;
  runTerminalHookForClaim(message: object, claim: object, expiresAtMs: number): Promise<unknown>;
  expirePendingTerminalHookHandoffs(nowMs: number): void;
};

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition did not become true");
}

describe("DaemonLoop handoff expiry coverage", () => {
  it("settles matching ordinary terminal status without a duplicate hook result", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const sent: HostToServerMessage[] = [];
      const transport = createLoopbackTransport({
        sendToServer: (message) => void sent.push(message),
      });
      const loop = new DaemonLoop({ config, transport });
      await loop.start();
      transport.deliver({ type: "host:registered", hostId: config.hostId, protocolVersion: 7 });
      pendingTerminalStatusOf(loop).set("lost\\0attempt", {
        message: {
          type: "session:status",
          sessionId: "lost",
          attemptId: "attempt",
          status: "failed",
          exitCode: null,
        },
        firstAttemptedAtMs: Date.now(),
        sending: false,
        controller: new AbortController(),
      });
      transport.deliver({
        type: "session:terminal-hook",
        handoffId: "replacement",
        sessionId: "lost",
        repositoryId: "demo",
        worktreeId: "wt-1",
        status: "failed",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      await waitFor(() =>
        sent.some(
          (message) =>
            message.type === "session:terminal-hook-complete" &&
            message.handoffId === "replacement",
        ),
      );
      expect(sent).toContainEqual({
        type: "session:terminal-hook-complete",
        sessionId: "lost",
        handoffId: "replacement",
        result: { summary: "Session failed", summarySource: "harness" },
      });
      loop.stop();
    } finally {
      cleanup();
    }
  });

  it("does not run stale or legacy-expiry handoff work", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const logs: string[] = [];
      const loop = new DaemonLoop({
        config,
        transport: createLoopbackTransport(),
        onLog: (line) => logs.push(line),
      });
      const internals = loop as unknown as HandoffInternals;
      const message = {
        type: "session:terminal-hook" as const,
        handoffId: "handoff",
        sessionId: "lost",
        repositoryId: "demo",
        worktreeId: "wt-1",
        status: "failed" as const,
        expiresAt: new Date().toISOString(),
      };
      await internals.runTerminalHookHandoff({
        message,
        complete: false,
        executing: false,
        sending: false,
      });
      await internals.runTerminalHookHandoff({
        message,
        expiresAtMs: 0,
        complete: false,
        executing: false,
        sending: false,
      });
      await expect(
        internals.runTerminalHookForClaim(
          message,
          {
            currentHookTarget: async () => ({
              cwd: "/repo",
              repository: { terminalHookScript: "/hook.sh" },
            }),
          },
          0,
        ),
      ).resolves.toBeUndefined();
      internals.pendingTerminalHookHandoffs.set("legacy", {
        message,
        firstAttemptedAtMs: 0,
      });
      internals.expirePendingTerminalHookHandoffs(60_000 * 60 * 24 * 2);
      expect(logs).toContainEqual(expect.stringContaining("after"));
    } finally {
      cleanup();
    }
  });
});
