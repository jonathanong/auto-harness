import { describe, expect, it } from "vitest";

import type { HostToServerMessage } from "@auto-harness/shared";

import { DaemonLoop } from "./daemon-loop.ts";
import { SpawnProcessRunner, type ProcessRunner, type RunProcessOptions } from "./executor.ts";
import {
  createAcknowledgingLoopbackTransport,
  flushMicrotasks,
  makeRepo,
} from "../test-helpers/daemon-loop-test-helpers.ts";

function summaryCommandRunner(): ProcessRunner {
  return {
    async run(options: RunProcessOptions) {
      options.onChunk({ stream: "stdout", data: "done\n" });
      return {
        exitCode: 0,
        timedOut: false,
        signal: null,
        agentSummary: "Implemented the requested change.",
      };
    },
  };
}

function withoutGh(): ProcessRunner {
  const spawn = new SpawnProcessRunner();
  return {
    async run(options) {
      if (options.argv[0]?.endsWith("/gh")) {
        return { exitCode: 1, timedOut: false, signal: null };
      }
      return await spawn.run(options);
    },
  };
}

function assignment(sessionId: string) {
  return {
    type: "session:assign" as const,
    sessionId,
    attemptId: `attempt-${sessionId}`,
    repositoryId: "demo",
    prompt: "summarize",
    resolvedArgv: ["fake-command"],
    timeout: 30,
    worktreeId: "wt-1",
    assignedAt: new Date().toISOString(),
  };
}

describe("DaemonLoop structured terminal results", () => {
  it("omits results for protocol v2 but sends and exactly retries the v3 result", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const sent: HostToServerMessage[] = [];
      let v3StatusAttempts = 0;
      const transport = createAcknowledgingLoopbackTransport({
        sendToServer: (message) => {
          sent.push(message);
          if (message.type === "session:command-start") {
            transport.deliver({
              type: "session:command-start-acknowledged",
              sessionId: message.sessionId,
              attemptId: message.attemptId,
            });
          }
          if (message.type === "session:status" && message.sessionId === "v3") {
            v3StatusAttempts += 1;
            if (v3StatusAttempts === 1) throw new Error("disconnected");
          }
        },
      });
      let registered: ((protocolVersion?: number) => void) | undefined;
      const registerable = transport as typeof transport & {
        onRegistered?: (handler: (protocolVersion?: number) => void) => void;
      };
      registerable.onRegistered = (handler) => {
        registered = handler;
      };
      const loop = new DaemonLoop({
        config,
        transport,
        processRunner: withoutGh(),
        commandRunner: summaryCommandRunner(),
      });
      await loop.start();

      registered?.(2);
      transport.deliver(assignment("v2"));
      await loop.waitForIdle();
      const v2 = sent.find(
        (message): message is Extract<HostToServerMessage, { type: "session:status" }> =>
          message.type === "session:status" && message.sessionId === "v2",
      );
      expect(v2?.result).toBeUndefined();

      registered?.(3);
      transport.deliver(assignment("v3"));
      await loop.waitForIdle();
      const initial = sent.find(
        (message): message is Extract<HostToServerMessage, { type: "session:status" }> =>
          message.type === "session:status" && message.sessionId === "v3",
      );
      expect(initial?.result).toMatchObject({
        summary: "Implemented the requested change.",
        summarySource: "agent",
      });

      await loop.keepalive();
      await flushMicrotasks();
      const retries = sent.filter(
        (message): message is Extract<HostToServerMessage, { type: "session:status" }> =>
          message.type === "session:status" && message.sessionId === "v3",
      );
      expect(retries).toHaveLength(2);
      expect(retries[1]).toEqual(initial);
      loop.stop();
    } finally {
      cleanup();
    }
  });
});
