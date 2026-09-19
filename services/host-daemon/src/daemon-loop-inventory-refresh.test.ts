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

describe("DaemonLoop assignment inventory refresh", () => {
  it("refreshes a missing assignment target before acknowledging or executing it", async () => {
    const { config: currentConfig, cleanup } = await makeRepo();
    try {
      const staleConfig = { ...currentConfig, repositories: [] };
      const sent: HostToServerMessage[] = [];
      const events: string[] = [];
      const transport = createAcknowledgingLoopbackTransport({
        sendToServer: (message) => {
          sent.push(message);
          events.push(message.type);
        },
      });
      let refreshes = 0;
      const loop = new DaemonLoop({
        config: staleConfig,
        transport,
        refreshInventory: async () => {
          refreshes += 1;
          events.push("inventory:refresh");
          return currentConfig;
        },
      });
      await loop.start();

      transport.deliver(assignment());
      await loop.waitForIdle();

      expect(refreshes).toBe(1);
      expect(events.indexOf("session:ack")).toBeGreaterThan(events.indexOf("inventory:refresh"));
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

  it("withholds acknowledgement when the refreshed inventory still lacks the target", async () => {
    const { config: currentConfig, cleanup } = await makeRepo();
    try {
      const staleConfig = { ...currentConfig, repositories: [] };
      const sent: HostToServerMessage[] = [];
      const transport = createAcknowledgingLoopbackTransport({
        sendToServer: (message) => sent.push(message),
      });
      const loop = new DaemonLoop({
        config: staleConfig,
        transport,
        refreshInventory: async () => ({ ...currentConfig, repositories: [] }),
      });
      await loop.start();

      transport.deliver(assignment());
      await expect(loop.waitForIdle()).rejects.toThrow(
        "assignment target is absent from refreshed host inventory",
      );

      expect(sent.some((message) => message.type === "session:ack")).toBe(false);
      expect(sent.some((message) => message.type === "session:status")).toBe(false);
      loop.stop();
    } finally {
      cleanup();
    }
  });

  it("withholds acknowledgement when the authoritative inventory fetch fails", async () => {
    const { config: currentConfig, cleanup } = await makeRepo();
    try {
      const staleConfig = { ...currentConfig, repositories: [] };
      const sent: HostToServerMessage[] = [];
      const transport = createAcknowledgingLoopbackTransport({
        sendToServer: (message) => sent.push(message),
      });
      const loop = new DaemonLoop({
        config: staleConfig,
        transport,
        refreshInventory: () => Promise.reject(new Error("inventory unavailable")),
      });
      await loop.start();

      transport.deliver(assignment());
      await expect(loop.waitForIdle()).rejects.toThrow("inventory unavailable");

      expect(sent.some((message) => message.type === "session:ack")).toBe(false);
      expect(sent.some((message) => message.type === "session:status")).toBe(false);
      loop.stop();
    } finally {
      cleanup();
    }
  });

  it("retains a policy drain that appears during an assignment refresh", async () => {
    const { config: currentConfig, cleanup } = await makeRepo();
    try {
      const staleConfig = { ...currentConfig, repositories: [] };
      const sent: HostToServerMessage[] = [];
      const transport = createAcknowledgingLoopbackTransport({
        sendToServer: (message) => sent.push(message),
      });
      const loop = new DaemonLoop({
        config: staleConfig,
        transport,
        refreshInventory: async () => currentConfig,
      });
      await loop.start();
      let finishValidation!: () => void;
      const validationPending = new Promise<void>((resolve) => {
        finishValidation = resolve;
      });
      let validationStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        validationStarted = resolve;
      });
      const worktrees = (
        loop as unknown as {
          worktrees: { ensureAll(next?: unknown): Promise<void> };
        }
      ).worktrees;
      worktrees.ensureAll = async () => {
        validationStarted();
        await validationPending;
      };

      transport.deliver(assignment());
      await started;
      await loop.blockAssignmentsForInvalidInventory();
      finishValidation();
      await loop.waitForIdle();

      expect(loop.isDraining()).toBe(true);
      expect(sent.filter((message) => message.type === "host:register").at(-1)).toMatchObject({
        draining: true,
      });
      expect(sent.some((message) => message.type === "session:ack")).toBe(false);
      expect(sent.some((message) => message.type === "session:status")).toBe(false);
      loop.stop();
    } finally {
      cleanup();
    }
  });
});
