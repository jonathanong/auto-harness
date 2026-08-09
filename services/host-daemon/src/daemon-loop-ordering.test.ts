import { describe, expect, it } from "vitest";

import type { HostToServerMessage, HostWireMessage } from "@auto-harness/shared";

import { DaemonLoop, createLoopbackTransport } from "./daemon-loop.ts";
import { makeRepo } from "./daemon-loop-test-helpers.ts";

describe("DaemonLoop outbound delivery", () => {
  it("delivers all logs before exactly one terminal status", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const sent: HostToServerMessage[] = [];
      const transport = createLoopbackTransport({
        sendToServer: async (message) => {
          await new Promise<void>((resolve) => setTimeout(resolve, 1));
          sent.push(message);
        },
      });
      const loop = new DaemonLoop({ config, transport });
      await loop.start();
      const assign: HostWireMessage = {
        type: "session:assign",
        sessionId: "ordered",
        repositoryId: "demo",
        prompt: "hello",
        resolvedArgv: ["printf", "%s", "hello"],
        timeout: 30,
        worktreeId: "wt-1",
        assignedAt: new Date().toISOString(),
      };
      transport.deliver(assign);
      await loop.waitForIdle();
      const terminal = sent.filter((message) => message.type === "session:status");
      expect(terminal).toHaveLength(1);
      expect(sent.findIndex((message) => message.type === "session:status")).toBeGreaterThan(
        sent.map((message) => message.type).lastIndexOf("session:log"),
      );
      loop.stop();
    } finally {
      cleanup();
    }
  });

  it("continues after a send failure and suppresses duplicate assigns", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const sent: HostToServerMessage[] = [];
      let failLogOnce = false;
      const transport = createLoopbackTransport({
        sendToServer: (message) => {
          if (failLogOnce && message.type === "session:log") {
            failLogOnce = false;
            throw "temporary send failure";
          }
          sent.push(message);
        },
      });
      const loop = new DaemonLoop({ config, transport });
      await loop.start();
      failLogOnce = true;
      const assign: HostWireMessage = {
        type: "session:assign",
        sessionId: "once",
        repositoryId: "demo",
        prompt: "hello",
        resolvedArgv: ["printf", "%s", "hello"],
        timeout: 30,
        worktreeId: "wt-1",
        assignedAt: new Date().toISOString(),
      };
      transport.deliver(assign);
      transport.deliver(assign);
      await loop.waitForIdle();
      expect(sent.filter((message) => message.type === "session:status")).toHaveLength(1);
      loop.stop();
    } finally {
      cleanup();
    }
  });

  it("does not execute an assignment whose acknowledgement cannot be delivered", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const logs: string[] = [];
      const transport = createLoopbackTransport({
        sendToServer: (message) => {
          if (message.type === "session:ack") throw "offline";
        },
      });
      const loop = new DaemonLoop({ config, transport, onLog: (line) => logs.push(line) });
      await loop.start();
      transport.deliver({
        type: "session:assign",
        sessionId: "unacked",
        repositoryId: "demo",
        prompt: "hello",
        resolvedArgv: ["printf", "%s", "hello"],
        timeout: 30,
        worktreeId: "wt-1",
        assignedAt: new Date().toISOString(),
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      expect(logs.some((line) => line.includes("server message failed: offline"))).toBe(true);
      expect(loop.inflightCount()).toBe(0);
      loop.stop();
    } finally {
      cleanup();
    }
  });

  it("aborts an actively tracked session when it receives cancellation", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const transport = createLoopbackTransport({ sendToServer: () => undefined });
      const loop = new DaemonLoop({ config, transport });
      await loop.start();
      const controller = new AbortController();
      (
        loop as unknown as {
          inflight: Map<string, { controller: AbortController; work: Promise<void> }>;
        }
      ).inflight.set("running", { controller, work: Promise.resolve() });
      transport.deliver({ type: "session:cancel", sessionId: "running" });
      expect(controller.signal.aborted).toBe(true);
      loop.stop();
    } finally {
      cleanup();
    }
  });
});
