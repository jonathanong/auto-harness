import { describe, expect, it } from "vitest";

import type { HostToServerMessage } from "@auto-harness/shared";

import { DaemonLoop } from "./daemon-loop.ts";
import type { ProcessRunner } from "./executor.ts";
import {
  createAcknowledgingLoopbackTransport,
  makeRepo,
} from "../test-helpers/daemon-loop-test-helpers.ts";

describe("DaemonLoop output assignment drain race", () => {
  it("does not acknowledge or run an assignment when draining begins during inventory refresh", async () => {
    const { config, cleanup } = await makeRepo();
    const sent: HostToServerMessage[] = [];
    let draining = false;
    let refreshStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      refreshStarted = resolve;
    });
    let releaseRefresh!: () => void;
    const refreshPending = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    let commandRuns = 0;
    const commandRunner: ProcessRunner = {
      async run() {
        commandRuns += 1;
        return { exitCode: 0, timedOut: false, signal: null };
      },
    };
    const transport = createAcknowledgingLoopbackTransport({
      sendToServer: (message) => sent.push(message),
    });
    const loop = new DaemonLoop({
      config: { ...config, repositories: [] },
      transport,
      commandRunner,
      isDraining: () => draining,
      refreshInventory: async () => {
        refreshStarted();
        await refreshPending;
        return config;
      },
    });
    try {
      await loop.start();
      transport.deliver({
        type: "session:assign",
        sessionId: "draining-during-refresh",
        attemptId: "attempt-draining-during-refresh",
        sessionType: "scheduled",
        repositoryId: "demo",
        worktreeId: "wt-1",
        prompt: "run task",
        resolvedArgv: ["true"],
        timeout: 30,
        assignedAt: new Date().toISOString(),
      });
      await started;
      draining = true;
      releaseRefresh();
      await loop.waitForIdle();

      expect(commandRuns).toBe(0);
      expect(sent.some((message) => message.type === "session:ack")).toBe(false);
      expect(sent.some((message) => message.type === "session:status")).toBe(false);
    } finally {
      loop.stop();
      cleanup();
    }
  });
});
