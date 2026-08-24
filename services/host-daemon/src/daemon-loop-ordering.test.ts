/* eslint-disable max-lines -- delayed old-attempt cancel/ack races stay with ordering cases. */
import { describe, expect, it } from "vitest";

import type { HostToServerMessage, HostWireMessage } from "@auto-harness/shared";

import { DaemonLoop, createLoopbackTransport } from "./daemon-loop.ts";
import { createAcknowledgingLoopbackTransport, makeRepo } from "./daemon-loop-test-helpers.ts";

function seqAssign(attemptId: string): HostWireMessage {
  return {
    type: "session:assign",
    sessionId: "seq-session",
    attemptId,
    repositoryId: "demo",
    prompt: "hello",
    resolvedArgv: ["printf", "%s", "hello"],
    timeout: 30,
    worktreeId: "wt-1",
    assignedAt: new Date().toISOString(),
  };
}

describe("DaemonLoop outbound delivery", () => {
  it("delivers all logs before exactly one terminal status", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const sent: HostToServerMessage[] = [];
      const transport = createAcknowledgingLoopbackTransport({
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
        attemptId: "attempt-ordered",
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
      const transport = createAcknowledgingLoopbackTransport({
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
        attemptId: "attempt-once",
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
          if (message.type === "session:ack") throw new Error("offline");
        },
      });
      const loop = new DaemonLoop({ config, transport, onLog: (line) => logs.push(line) });
      await loop.start();
      transport.deliver({
        type: "session:assign",
        sessionId: "unacked",
        attemptId: "attempt-unacked",
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
          inflight: Map<
            string,
            {
              sessionId: string;
              attemptId: string;
              controller: AbortController;
              work: Promise<void>;
              acknowledged: boolean;
            }
          >;
        }
      ).inflight.set("running\0attempt-running", {
        sessionId: "running",
        attemptId: "attempt-running",
        controller,
        work: Promise.resolve(),
        acknowledged: true,
      });
      transport.deliver({
        type: "session:cancel",
        sessionId: "running",
        attemptId: "attempt-running",
      });
      expect(controller.signal.aborted).toBe(true);
      loop.stop();
    } finally {
      cleanup();
    }
  });

  it("ignores a delayed cancel or acknowledgement from an old attempt", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const transport = createLoopbackTransport({ sendToServer: () => undefined });
      const loop = new DaemonLoop({ config, transport });
      await loop.start();
      const current = new AbortController();
      const stale = new AbortController();
      (
        loop as unknown as {
          inflight: Map<
            string,
            {
              sessionId: string;
              attemptId: string;
              controller: AbortController;
              work: Promise<void>;
              acknowledged: boolean;
            }
          >;
        }
      ).inflight.set("running\0attempt-2", {
        sessionId: "running",
        attemptId: "attempt-2",
        controller: current,
        work: Promise.resolve(),
        acknowledged: false,
      });
      transport.deliver({
        type: "session:cancel",
        sessionId: "running",
        attemptId: "attempt-1",
      });
      transport.deliver({
        type: "session:acknowledged",
        sessionId: "running",
        attemptId: "attempt-1",
      });
      expect(current.signal.aborted).toBe(false);
      transport.deliver({
        type: "session:acknowledged",
        sessionId: "running",
        attemptId: "attempt-2",
      });
      expect(
        (
          loop as unknown as {
            inflight: Map<string, { acknowledged: boolean; controller: AbortController }>;
          }
        ).inflight.get("running\0attempt-2")?.acknowledged,
      ).toBe(true);
      transport.deliver({
        type: "session:cancel",
        sessionId: "running",
        attemptId: "attempt-2",
      });
      expect(current.signal.aborted).toBe(true);
      expect(stale.signal.aborted).toBe(false);
      loop.stop();
    } finally {
      cleanup();
    }
  });

  it("aborts a superseded inflight attempt when a new assign arrives for the same session", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const logs: string[] = [];
      const transport = createLoopbackTransport({ sendToServer: () => undefined });
      const loop = new DaemonLoop({
        config,
        transport,
        onLog: (line) => logs.push(line),
        runtime: { daemonVersion: "test", gitVersion: "2.36.0", gitReady: true },
      });
      await loop.start();
      const previous = new AbortController();
      (
        loop as unknown as {
          inflight: Map<
            string,
            {
              sessionId: string;
              attemptId: string;
              controller: AbortController;
              work: Promise<void>;
              acknowledged: boolean;
            }
          >;
        }
      ).inflight.set("running\0attempt-1", {
        sessionId: "running",
        attemptId: "attempt-1",
        controller: previous,
        work: Promise.resolve(),
        acknowledged: true,
      });
      transport.deliver({
        type: "session:assign",
        sessionId: "running",
        attemptId: "attempt-2",
        repositoryId: "demo",
        prompt: "hello",
        resolvedArgv: ["printf", "%s", "hello"],
        timeout: 30,
        worktreeId: "wt-1",
        assignedAt: new Date().toISOString(),
      });
      await Promise.resolve();
      expect(previous.signal.aborted).toBe(true);
      expect(logs.some((line) => line.includes("superseded attempt attempt-1"))).toBe(true);
      loop.stop();
    } finally {
      cleanup();
    }
  });

  it("keeps log sequence monotonic across attempts of the same session", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const sent: HostToServerMessage[] = [];
      const transport = createAcknowledgingLoopbackTransport({
        sendToServer: (message) => {
          sent.push(message);
        },
      });
      const loop = new DaemonLoop({ config, transport });
      await loop.start();
      transport.deliver(seqAssign("attempt-seq-1"));
      await loop.waitForIdle();
      const firstLogs = sent.filter(
        (message) => message.type === "session:log" && message.sessionId === "seq-session",
      );
      expect(firstLogs.length).toBeGreaterThan(0);
      const lastSeq = firstLogs.at(-1)!.seq;
      transport.deliver(seqAssign("attempt-seq-2"));
      await loop.waitForIdle();
      const secondLogs = sent.filter(
        (message) =>
          message.type === "session:log" &&
          message.sessionId === "seq-session" &&
          message.attemptId === "attempt-seq-2",
      );
      expect(secondLogs[0]?.seq).toBe(lastSeq + 1);
      loop.stop();
    } finally {
      cleanup();
    }
  });

  it("refuses a new assignment when git is not ready", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const logs: string[] = [];
      const transport = createAcknowledgingLoopbackTransport({ sendToServer: () => undefined });
      const loop = new DaemonLoop({
        config,
        transport,
        onLog: (line) => logs.push(line),
        runtime: {
          daemonVersion: "test",
          gitVersion: null,
          gitReady: false,
          gitReadinessReason: "git_not_found",
        },
      });
      await loop.start();
      transport.deliver(seqAssign("attempt-seq-unready"));
      await loop.waitForIdle();
      expect(logs.some((line) => line.includes("git not ready"))).toBe(true);
      loop.stop();
    } finally {
      cleanup();
    }
  });

  it("waits for a superseded aborted attempt before running the replacement", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const transport = createAcknowledgingLoopbackTransport({ sendToServer: () => undefined });
      const loop = new DaemonLoop({
        config,
        transport,
        runtime: { daemonVersion: "test", gitVersion: "2.36.0", gitReady: true },
      });
      await loop.start();
      const previous = new AbortController();
      previous.abort();
      (
        loop as unknown as {
          inflight: Map<
            string,
            {
              sessionId: string;
              attemptId: string;
              controller: AbortController;
              work: Promise<void>;
              acknowledged: boolean;
            }
          >;
        }
      ).inflight.set("seq-session\0attempt-old", {
        sessionId: "seq-session",
        attemptId: "attempt-old",
        controller: previous,
        work: Promise.resolve(),
        acknowledged: true,
      });
      transport.deliver(seqAssign("attempt-seq-next"));
      await loop.waitForIdle();
      loop.stop();
    } finally {
      cleanup();
    }
  });
});
