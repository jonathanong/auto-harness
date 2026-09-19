import { afterEach, describe, expect, it, vi } from "vitest";

import type { HostToServerMessage, HostWireMessage } from "@auto-harness/shared";

import { HostInventoryPolicyError } from "./bootstrap.ts";
import { DaemonLoop } from "./daemon-loop.ts";
import {
  createAcknowledgingLoopbackTransport,
  makeRepo,
} from "../test-helpers/daemon-loop-test-helpers.ts";

afterEach(() => vi.useRealTimers());

function assignment(): Extract<HostWireMessage, { type: "session:assign" }> {
  return {
    type: "session:assign",
    sessionId: "refresh-error",
    attemptId: "attempt-refresh-error",
    repositoryId: "demo",
    prompt: "hello",
    resolvedArgv: ["printf", "%s", "hello"],
    timeout: 30,
    worktreeId: "wt-1",
    assignedAt: new Date().toISOString(),
  };
}

describe("DaemonLoop assignment inventory refresh errors", () => {
  it("bounds an inventory fetch that never settles", async () => {
    vi.useFakeTimers();
    const { config, cleanup } = await makeRepo();
    try {
      const transport = createAcknowledgingLoopbackTransport({ sendToServer() {} });
      let refreshStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        refreshStarted = resolve;
      });
      const loop = new DaemonLoop({
        config: { ...config, repositories: [] },
        transport,
        refreshInventory: () => {
          refreshStarted();
          return new Promise(() => undefined);
        },
      });
      await loop.start();

      transport.deliver(assignment());
      await started;
      const idle = expect(loop.waitForIdle()).rejects.toThrow(
        "assignment inventory refresh timed out",
      );
      await vi.advanceTimersByTimeAsync(10_000);
      await idle;
      loop.stop();
    } finally {
      cleanup();
    }
  });

  it("publishes a policy drain when the refreshed inventory is unsafe", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const sent: HostToServerMessage[] = [];
      const transport = createAcknowledgingLoopbackTransport({
        sendToServer: (message) => sent.push(message),
      });
      const loop = new DaemonLoop({
        config: { ...config, repositories: [] },
        transport,
        refreshInventory: () =>
          Promise.reject(new HostInventoryPolicyError("outside root", ["/allowed"])),
      });
      await loop.start();

      transport.deliver(assignment());
      await expect(loop.waitForIdle()).rejects.toThrow("outside root");

      expect(loop.isDraining()).toBe(true);
      expect(sent.filter((message) => message.type === "host:register").at(-1)).toMatchObject({
        draining: true,
      });
      expect(sent.some((message) => message.type === "session:ack")).toBe(false);
      loop.stop();
    } finally {
      cleanup();
    }
  });
});
