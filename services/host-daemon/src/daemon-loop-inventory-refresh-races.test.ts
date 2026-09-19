import { describe, expect, it } from "vitest";

import type { HostToServerMessage, HostWireMessage } from "@auto-harness/shared";

import { DaemonLoop } from "./daemon-loop.ts";
import {
  createAcknowledgingLoopbackTransport,
  makeRepo,
} from "../test-helpers/daemon-loop-test-helpers.ts";

function assignment(): Extract<HostWireMessage, { type: "session:assign" }> {
  return {
    type: "session:assign",
    sessionId: "freshly-attached",
    attemptId: "attempt-freshly-attached",
    repositoryId: "demo",
    prompt: "hello",
    resolvedArgv: ["printf", "%s", "hello"],
    timeout: 30,
    worktreeId: "wt-1",
    assignedAt: new Date().toISOString(),
  };
}

function scheduledAssignment(
  sessionId: string,
  repositoryId: string,
): Extract<HostWireMessage, { type: "session:assign" }> {
  return {
    ...assignment(),
    sessionId,
    attemptId: `attempt-${sessionId}`,
    sessionType: "scheduled",
    repositoryId,
    worktreeId: null,
  };
}

describe("DaemonLoop assignment inventory refresh races", () => {
  it("fetches again when a shared refresh snapshot predates another attached repository", async () => {
    const { config: currentConfig, cleanup } = await makeRepo();
    try {
      const staleConfig = { ...currentConfig, repositories: [] };
      const firstSnapshot = { ...currentConfig };
      const secondRepository = {
        ...currentConfig.repositories[0]!,
        id: "second-repository",
        worktrees: [],
      };
      const latestSnapshot = {
        ...currentConfig,
        repositories: [...currentConfig.repositories, secondRepository],
      };
      let releaseFirstRefresh!: () => void;
      const firstRefreshPending = new Promise<void>((resolve) => {
        releaseFirstRefresh = resolve;
      });
      let refreshes = 0;
      const sent: HostToServerMessage[] = [];
      const transport = createAcknowledgingLoopbackTransport({
        sendToServer: (message) => sent.push(message),
      });
      const loop = new DaemonLoop({
        config: staleConfig,
        transport,
        refreshInventory: async () => {
          refreshes += 1;
          if (refreshes === 1) {
            await firstRefreshPending;
            return firstSnapshot;
          }
          return latestSnapshot;
        },
      });
      await loop.start();

      transport.deliver(scheduledAssignment("first-attach", "demo"));
      transport.deliver(scheduledAssignment("second-attach", "second-repository"));
      releaseFirstRefresh();
      await loop.waitForIdle();

      expect(refreshes).toBe(2);
      expect(
        sent.filter(
          (message) =>
            message.type === "session:status" &&
            (message.sessionId === "first-attach" || message.sessionId === "second-attach") &&
            message.status === "completed",
        ),
      ).toHaveLength(2);
      loop.stop();
    } finally {
      cleanup();
    }
  });

  it("serializes full reloads and accepts a recreated inventory with a lower version", async () => {
    const { config: currentConfig, cleanup } = await makeRepo();
    try {
      const staleConfig = { ...currentConfig, inventoryVersion: 8, repositories: [] };
      const sent: HostToServerMessage[] = [];
      const transport = createAcknowledgingLoopbackTransport({
        sendToServer: (message) => sent.push(message),
      });
      const loop = new DaemonLoop({ config: staleConfig, transport });
      await loop.start();
      let releaseOldReload!: () => void;
      const oldReloadPending = new Promise<void>((resolve) => {
        releaseOldReload = resolve;
      });
      let recreatedReloadStarted = false;

      const oldReload = loop.reloadInventory(async () => {
        await oldReloadPending;
        return { ...currentConfig, inventoryVersion: 9, repositories: [] };
      });
      const recreatedReload = loop.reloadInventory(async () => {
        recreatedReloadStarted = true;
        return { ...currentConfig, inventoryVersion: 1 };
      });
      await Promise.resolve();
      expect(recreatedReloadStarted).toBe(false);

      releaseOldReload();
      await oldReload;
      await recreatedReload;
      expect(recreatedReloadStarted).toBe(true);
      transport.deliver(assignment());
      await loop.waitForIdle();

      expect(
        sent.some(
          (message) =>
            message.type === "session:status" &&
            message.sessionId === "freshly-attached" &&
            message.status === "completed",
        ),
      ).toBe(true);
      loop.stop();
    } finally {
      cleanup();
    }
  });

  it("aborts a sole in-flight refresh when its assignment is cancelled", async () => {
    const { config: currentConfig, cleanup } = await makeRepo();
    try {
      const staleConfig = { ...currentConfig, repositories: [] };
      const sent: HostToServerMessage[] = [];
      const transport = createAcknowledgingLoopbackTransport({
        sendToServer: (message) => sent.push(message),
      });
      let refreshSignal: AbortSignal | undefined;
      let refreshStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        refreshStarted = resolve;
      });
      const loop = new DaemonLoop({
        config: staleConfig,
        transport,
        refreshInventory: (signal) => {
          refreshSignal = signal;
          refreshStarted();
          return new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        },
      });
      await loop.start();

      transport.deliver(assignment());
      await started;
      transport.deliver({
        type: "session:cancel",
        sessionId: "freshly-attached",
        attemptId: "attempt-freshly-attached",
      });
      await loop.waitForIdle();

      expect(refreshSignal?.aborted).toBe(true);
      expect(sent.some((message) => message.type === "session:ack")).toBe(false);
      expect(sent.some((message) => message.type === "session:status")).toBe(false);
      loop.stop();
    } finally {
      cleanup();
    }
  });
});
