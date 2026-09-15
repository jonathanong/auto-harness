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
  it("sends a structured result and retries the same payload after a disconnect", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const sent: HostToServerMessage[] = [];
      let statusAttempts = 0;
      const transport = createAcknowledgingLoopbackTransport({
        sendToServer: (message) => {
          sent.push(message);
          if (message.type === "session:status" && message.sessionId === "result") {
            statusAttempts += 1;
            if (statusAttempts === 1) throw new Error("disconnected");
          }
        },
      });
      const loop = new DaemonLoop({
        config,
        transport,
        processRunner: withoutGh(),
        commandRunner: summaryCommandRunner(),
      });
      await loop.start();

      transport.deliver(assignment("result"));
      await loop.waitForIdle();
      const initial = sent.find(
        (message): message is Extract<HostToServerMessage, { type: "session:status" }> =>
          message.type === "session:status" && message.sessionId === "result",
      );
      expect(initial?.result).toMatchObject({
        summary: "Implemented the requested change.",
        summarySource: "agent",
      });

      await loop.keepalive();
      await flushMicrotasks();
      const retries = sent.filter(
        (message): message is Extract<HostToServerMessage, { type: "session:status" }> =>
          message.type === "session:status" && message.sessionId === "result",
      );
      expect(retries).toHaveLength(2);
      expect(retries[1]).toEqual(initial);
      loop.stop();
    } finally {
      cleanup();
    }
  });
});
