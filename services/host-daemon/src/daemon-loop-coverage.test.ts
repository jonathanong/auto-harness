import { describe, expect, it } from "vitest";

import type { HostWireMessage } from "@auto-harness/shared";

import { DaemonLoop, createLoopbackTransport } from "./daemon-loop.ts";
import { makeRepo } from "./daemon-loop-test-helpers.ts";

type Inflight = {
  controller: AbortController;
  work: Promise<void>;
  acknowledged: boolean;
};

type LoopInternals = {
  inflight: Map<string, Inflight>;
  handleServerMessage(message: HostWireMessage): Promise<void>;
  waitForAcknowledgement(sessionId: string, signal: AbortSignal): Promise<boolean>;
};

function assign(sessionId: string): Extract<HostWireMessage, { type: "session:assign" }> {
  return {
    type: "session:assign",
    sessionId,
    repositoryId: "demo",
    prompt: "hello",
    resolvedArgv: ["printf", "%s", "hello"],
    timeout: 30,
    worktreeId: "wt-1",
    assignedAt: new Date().toISOString(),
  };
}

describe("DaemonLoop coverage guards", () => {
  it("handles listener and acknowledgement races without starting duplicate work", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const rejectedTransport = createLoopbackTransport({
        sendToServer: (message) => {
          if (message.type === "session:ack") throw new Error("offline");
        },
      });
      const unloggedLoop = new DaemonLoop({ config, transport: rejectedTransport });
      await unloggedLoop.start();
      rejectedTransport.deliver(assign("listener-error"));
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      expect(unloggedLoop.inflightCount()).toBe(0);
      unloggedLoop.stop();

      const lines: string[] = [];
      let markAcknowledged: (() => void) | undefined;
      const loop = new DaemonLoop({
        config,
        transport: createLoopbackTransport({ sendToServer: () => undefined }),
        onLog: (line) => lines.push(line),
        timers: {
          setTimeout: () => {
            markAcknowledged?.();
            return 0 as never;
          },
          clearTimeout: () => undefined,
        },
      });
      const internals = loop as unknown as LoopInternals;
      const raced: Inflight = {
        controller: new AbortController(),
        work: Promise.resolve(),
        acknowledged: false,
      };
      internals.inflight.set("raced", raced);
      markAcknowledged = () => {
        raced.acknowledged = true;
      };
      await expect(
        internals.waitForAcknowledgement("raced", raced.controller.signal),
      ).resolves.toBe(true);

      internals.inflight.set("early", {
        controller: new AbortController(),
        work: Promise.resolve(),
        acknowledged: false,
      });
      internals.inflight.set("duplicate", {
        controller: new AbortController(),
        work: Promise.resolve(),
        acknowledged: true,
      });
      await internals.handleServerMessage({ type: "session:acknowledged", sessionId: "early" });
      await internals.handleServerMessage(assign("duplicate"));
      expect(lines).toContain("duplicate assign ignored for duplicate");
      loop.stop();
    } finally {
      cleanup();
    }
  });
});
