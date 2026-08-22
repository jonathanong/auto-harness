import { describe, expect, it } from "vitest";

import type { HostToServerMessage } from "@auto-harness/shared";

import { DaemonLoop, createLoopbackTransport } from "./daemon-loop.ts";
import { makeRepo } from "./daemon-loop-test-helpers.ts";

describe("DaemonLoop Git readiness", () => {
  it("registers an unready daemon without initializing worktrees", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const messages: HostToServerMessage[] = [];
      const loop = new DaemonLoop({
        config,
        transport: createLoopbackTransport({ sendToServer: (message) => messages.push(message) }),
        processRunner: {
          run: async () => {
            throw new Error("Git must not be called while unready");
          },
        },
        runtime: {
          daemonVersion: "test",
          gitVersion: null,
          gitReady: false,
          gitReadinessReason: "git_unavailable",
        },
      });

      await loop.start();
      expect(messages).toContainEqual(
        expect.objectContaining({
          type: "host:register",
          runtime: expect.objectContaining({ gitReady: false }),
        }),
      );
      loop.stop();
    } finally {
      cleanup();
    }
  });
});
