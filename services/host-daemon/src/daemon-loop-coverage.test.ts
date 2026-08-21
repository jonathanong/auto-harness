import { describe, expect, it } from "vitest";

import type { HostWireMessage } from "@auto-harness/shared";

import { DaemonLoop, createLoopbackTransport } from "./daemon-loop.ts";
import { createAcknowledgingLoopbackTransport, makeRepo } from "./daemon-loop-test-helpers.ts";

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
  it("logs complete scheduler route metadata before executing", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const lines: string[] = [];
      const transport = createAcknowledgingLoopbackTransport({ sendToServer: () => undefined });
      const loop = new DaemonLoop({ config, transport, onLog: (line) => lines.push(line) });
      await loop.start();
      transport.deliver({
        ...assign("routed"),
        targetIndex: 0,
        commandId: "command-1",
        providerAccountId: "account-1",
      });
      transport.deliver({ ...assign("provider-only"), providerAccountId: "account-1" });
      transport.deliver({ ...assign("command-only"), commandId: "command-1" });
      await loop.waitForIdle();
      expect(lines).toContain(
        "resolved route for routed: target=0 command=command-1 providerAccount=account-1",
      );
      expect(lines).toContain(
        "resolved route for provider-only: target=? providerAccount=account-1",
      );
      expect(lines).toContain("resolved route for command-only: target=? command=command-1");
      loop.stop();
    } finally {
      cleanup();
    }
  });

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

      const primitiveLines: string[] = [];
      const primitiveTransport = createLoopbackTransport({
        sendToServer: (message) => {
          if (message.type === "session:ack") throw "primitive offline";
        },
      });
      const primitiveLoop = new DaemonLoop({
        config,
        transport: primitiveTransport,
        onLog: (line) => primitiveLines.push(line),
      });
      await primitiveLoop.start();
      primitiveTransport.deliver(assign("primitive-error"));
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      expect(primitiveLines).toContain("server message failed: primitive offline");
      primitiveLoop.stop();

      const lines: string[] = [];
      let markAcknowledged: (() => void) | undefined;
      const loop = new DaemonLoop({
        config,
        transport: createLoopbackTransport({ sendToServer: () => undefined }),
        onLog: (line) => lines.push(line),
        runtime: { daemonVersion: "test", gitVersion: "2.36.0", gitReady: true },
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

  it("logs primitive drain retry failures and cancels the scheduled retry on stop", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      for (const failure of [new Error("error offline"), "primitive offline"]) {
        const failureMessage = failure instanceof Error ? failure.message : failure;
        let retry: (() => void) | undefined;
        let cleared = false;
        const lines: string[] = [];
        const transport = createLoopbackTransport({
          sendToServer: (message) => {
            if (message.type === "host:status") throw failure;
          },
        });
        const loop = new DaemonLoop({
          config,
          transport,
          onLog: (line) => lines.push(line),
          timers: {
            // beginDrain schedules the retry first and the drain deadline second;
            // this test drives the retry, so keep the first callback.
            setTimeout: (callback) => {
              retry ??= callback;
              return 1 as never;
            },
            clearTimeout: () => {
              cleared = true;
            },
          },
        });
        await loop.start();
        void loop.beginDrain();
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(lines).toContain(`drain notification failed: ${failureMessage}`);
        retry?.();
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(lines).toContain(`drain notification retry failed: ${failureMessage}`);
        loop.stop();
        expect(cleared).toBe(true);
      }
    } finally {
      cleanup();
    }
  });
});
