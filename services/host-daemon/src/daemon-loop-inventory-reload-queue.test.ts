import { afterEach, describe, expect, it, vi } from "vitest";

import type { HostWireMessage } from "@auto-harness/shared";

import { HostInventoryPolicyError } from "./bootstrap.ts";
import { DaemonLoop } from "./daemon-loop.ts";
import { startInventoryPoll } from "./start-daemon.ts";
import {
  createAcknowledgingLoopbackTransport,
  makeRepo,
} from "../test-helpers/daemon-loop-test-helpers.ts";

afterEach(() => vi.useRealTimers());

const assignment: Extract<HostWireMessage, { type: "session:assign" }> = {
  type: "session:assign",
  sessionId: "queued-refresh",
  attemptId: "attempt-queued-refresh",
  repositoryId: "demo",
  prompt: "hello",
  resolvedArgv: ["printf", "%s", "hello"],
  timeout: 30,
  worktreeId: "wt-1",
  assignedAt: new Date().toISOString(),
};

describe("DaemonLoop inventory reload queue", () => {
  it("times out an assignment refresh queued behind an earlier reload", async () => {
    vi.useFakeTimers();
    const { config, cleanup } = await makeRepo();
    try {
      const staleConfig = { ...config, repositories: [] };
      let assignmentLoads = 0;
      const transport = createAcknowledgingLoopbackTransport({ sendToServer() {} });
      const loop = new DaemonLoop({
        config: staleConfig,
        transport,
        refreshInventory: async () => {
          assignmentLoads += 1;
          return config;
        },
      });
      await loop.start();
      let releaseEarlier!: () => void;
      const earlierPending = new Promise<void>((resolve) => {
        releaseEarlier = resolve;
      });
      let earlierStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        earlierStarted = resolve;
      });
      const earlier = loop.reloadInventory(async () => {
        earlierStarted();
        await earlierPending;
        return staleConfig;
      });
      await started;

      transport.deliver(assignment);
      const idle = expect(loop.waitForIdle()).rejects.toThrow(
        "assignment inventory refresh timed out",
      );
      await vi.advanceTimersByTimeAsync(10_000);
      await idle;
      expect(assignmentLoads).toBe(0);

      releaseEarlier();
      await earlier;
      await vi.advanceTimersByTimeAsync(0);
      expect(assignmentLoads).toBe(0);
      loop.stop();
    } finally {
      cleanup();
    }
  });

  it("lets an unchanged poll clear a fence installed by an assignment reload", async () => {
    vi.useFakeTimers();
    const { config, cleanup } = await makeRepo();
    const transport = createAcknowledgingLoopbackTransport({ sendToServer() {} });
    const loop = new DaemonLoop({ config, transport });
    await loop.start();
    const identity = { hostId: config.hostId, apiUrl: "http://control.test" };
    let stop: (() => Promise<void>) | undefined;
    try {
      await expect(
        loop.reloadInventory(async () => {
          throw new HostInventoryPolicyError("outside root", ["/allowed"]);
        }),
      ).rejects.toThrow("outside root");
      expect(loop.isInventoryPolicyBlocked()).toBe(true);

      stop = startInventoryPoll({
        config,
        identity,
        applyInventory: (next) => loop.applyInventory(next),
        reloadInventory: (loadInventory, shouldApply) =>
          loop.reloadInventory(loadInventory, { shouldApply }),
        isPolicyBlocked: () => loop.isInventoryPolicyBlocked(),
        pollMs: 10,
        fetchFn: async () =>
          Response.json({
            ...(config.inventoryVersion === undefined ? {} : { version: config.inventoryVersion }),
            repositories: config.repositories,
          }),
        log: () => undefined,
        error: () => undefined,
      });
      await vi.advanceTimersByTimeAsync(10);
      await stop();
      stop = undefined;

      expect(loop.isInventoryPolicyBlocked()).toBe(false);
    } finally {
      await stop?.();
      loop.stop();
      cleanup();
    }
  });
});
