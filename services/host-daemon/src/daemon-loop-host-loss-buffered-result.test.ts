import { describe, expect, it, vi } from "vitest";

import type { HostToServerMessage } from "@auto-harness/shared";
import { DaemonLoop, createLoopbackTransport } from "./daemon-loop.ts";
import {
  flushMacrotask,
  makeRepo,
  pendingTerminalStatusOf,
  terminalStatusFixture,
} from "../test-helpers/daemon-loop-test-helpers.ts";

const bufferedResult = {
  summary: "buffered after hook",
  summarySource: "harness" as const,
  branch: "feat/session",
  filesChanged: ["README"],
  pullRequestUrl: "https://github.com/example/repo/pull/1",
};

type HandoffInternals = {
  reconcilePendingTerminalStatusForHandoff(
    sessionId: string,
    expiresAtMs: number,
  ): Promise<{ matched: boolean; result?: typeof bufferedResult }>;
};

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await flushMacrotask();
  }
  throw new Error("condition did not become true");
}

describe("DaemonLoop host-loss buffered result reuse", () => {
  it("forwards a buffered ordinary result without rerunning the hook", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const sent: HostToServerMessage[] = [];
      const transport = createLoopbackTransport({
        sendToServer: (message) => void sent.push(message),
      });
      const loop = new DaemonLoop({ config, transport });
      await loop.start();
      const run = vi.fn(async () => ({ exitCode: 0 }));
      (loop as unknown as { processRunner: { run: typeof run } }).processRunner = { run };
      transport.deliver({ type: "host:registered", hostId: config.hostId, protocolVersion: 7 });
      pendingTerminalStatusOf(loop).set("lost\0attempt", {
        message: {
          ...terminalStatusFixture,
          sessionId: "lost",
          attemptId: "attempt",
          result: bufferedResult,
        },
        firstAttemptedAtMs: Date.now(),
        sending: false,
        controller: new AbortController(),
      });
      transport.deliver({
        type: "session:terminal-hook",
        handoffId: "same-process",
        sessionId: "lost",
        repositoryId: "demo",
        worktreeId: "wt-1",
        status: "failed",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        errorCode: "host_lost",
      });
      await waitFor(() =>
        sent.some(
          (message) =>
            message.type === "session:terminal-hook-complete" &&
            message.handoffId === "same-process",
        ),
      );
      expect(run.mock.calls.filter(([options]) => options.argv[0] === "/bin/sh")).toHaveLength(0);
      expect(sent).toContainEqual({
        type: "session:terminal-hook-complete",
        sessionId: "lost",
        handoffId: "same-process",
        result: bufferedResult,
      });
      expect(pendingTerminalStatusOf(loop).has("lost\0attempt")).toBe(true);
      loop.stop();
    } finally {
      cleanup();
    }
  });

  it("leaves a replacement daemon unmatched so its hook still runs", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const sent: HostToServerMessage[] = [];
      const transport = createLoopbackTransport({
        sendToServer: (message) => void sent.push(message),
      });
      const loop = new DaemonLoop({ config, transport });
      await loop.start();
      const run = vi.fn(async () => ({ exitCode: 0 }));
      (loop as unknown as { processRunner: { run: typeof run } }).processRunner = { run };
      transport.deliver({ type: "host:registered", hostId: config.hostId, protocolVersion: 7 });
      const internals = loop as unknown as HandoffInternals;
      await expect(
        internals.reconcilePendingTerminalStatusForHandoff("absent", Date.now() + 60_000),
      ).resolves.toEqual({ matched: false });
      transport.deliver({
        type: "session:terminal-hook",
        handoffId: "replacement",
        sessionId: "absent",
        repositoryId: "demo",
        worktreeId: "wt-1",
        status: "failed",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        errorCode: "host_lost",
      });
      await waitFor(() =>
        sent.some(
          (message) =>
            message.type === "session:terminal-hook-complete" &&
            message.handoffId === "replacement",
        ),
      );
      expect(run.mock.calls.filter(([options]) => options.argv[0] === "/bin/sh")).toHaveLength(1);
      expect(sent).toContainEqual({
        type: "session:terminal-hook-complete",
        sessionId: "absent",
        handoffId: "replacement",
        result: { summary: "Session failed", summarySource: "harness" },
      });
      loop.stop();
    } finally {
      cleanup();
    }
  });
});
