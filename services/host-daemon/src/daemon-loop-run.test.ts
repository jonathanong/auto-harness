import { describe, expect, it } from "vitest";

import type { HostToServerMessage, HostWireMessage } from "@auto-harness/shared";

import { DaemonLoop } from "./daemon-loop.ts";
import { createAcknowledgingLoopbackTransport, makeRepo } from "./daemon-loop-test-helpers.ts";
import { SpawnProcessRunner, type ProcessRunner, type ProcessResult } from "./executor.ts";

describe("DaemonLoop run", () => {
  it("acks, runs, and reports a scheduled main-checkout assignment", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const serverMsgs: HostToServerMessage[] = [];
      const transport = createAcknowledgingLoopbackTransport({
        sendToServer: (message) => {
          serverMsgs.push(message);
        },
      });
      const loop = new DaemonLoop({ config, transport });
      await loop.start();
      transport.deliver({
        type: "session:assign",
        sessionId: "scheduled-main",
        sessionType: "scheduled",
        repositoryId: "demo",
        prompt: "run maintenance",
        resolvedArgv: ["printf", "%s\\n", "scheduled-main"],
        timeout: 30,
        worktreeId: null,
        ref: "main",
        assignedAt: new Date().toISOString(),
      });
      await loop.waitForIdle();

      expect(
        serverMsgs.some(
          (message) =>
            message.type === "session:ack" &&
            message.sessionId === "scheduled-main" &&
            message.worktreeId === null,
        ),
      ).toBe(true);
      expect(
        serverMsgs.some(
          (message) =>
            message.type === "session:status" &&
            message.sessionId === "scheduled-main" &&
            message.worktreeId === null &&
            message.status === "completed",
        ),
      ).toBe(true);
      loop.stop();
    } finally {
      cleanup();
    }
  });

  it("registers, acks, runs profile, reports terminal status and logs", async () => {
    const { config, cleanup } = await makeRepo();
    try {
      const serverMsgs: HostToServerMessage[] = [];
      const transport = createAcknowledgingLoopbackTransport({
        sendToServer: (m) => {
          serverMsgs.push(m);
        },
      });
      const loop = new DaemonLoop({ config, transport });
      await loop.start();
      expect(serverMsgs.some((m) => m.type === "host:register")).toBe(true);

      const assign: HostWireMessage = {
        type: "session:assign",
        sessionId: "sess-loop",
        repositoryId: "demo",
        prompt: "hello-loop",
        resolvedArgv: ["printf", "%s\n", "resume-ref: daemon-ref"],
        resumeRefCapture: { stream: "stdout", linePrefix: "resume-ref: " },
        timeout: 30,
        worktreeId: "wt-1",
        ref: "main",
        assignedAt: new Date().toISOString(),
      };
      transport.deliver(assign);
      await loop.waitForIdle();

      expect(serverMsgs.some((m) => m.type === "session:ack")).toBe(true);
      expect(serverMsgs.some((m) => m.type === "session:status" && m.status === "completed")).toBe(
        true,
      );
      expect(
        serverMsgs.some(
          (m) =>
            m.type === "session:status" &&
            m.status === "completed" &&
            m.cliResumeRef === "daemon-ref",
        ),
      ).toBe(true);
      expect(serverMsgs.some((m) => m.type === "session:log")).toBe(true);
      const systemLogs = serverMsgs.flatMap((message) =>
        message.type === "session:log" && message.stream === "system" ? [message.content] : [],
      );
      expect(systemLogs[0]).toMatch(/^Session started at /);
      expect(systemLogs).toContain("Spawning: printf (argument count: 2)");
      expect(systemLogs).toContain("Process exited with code 0");
      expect(systemLogs.at(-1)).toMatch(/^Session completed at /);

      await loop.keepalive();
      expect(serverMsgs.some((m) => m.type === "host:keepalive")).toBe(true);

      const registersBefore = serverMsgs.filter((m) => m.type === "host:register").length;
      await loop.applyInventory({
        ...config,
        commandProfiles: {
          ...config.commandProfiles,
          true: { argv: ["true"], appendPrompt: false },
        },
      });
      expect(serverMsgs.filter((m) => m.type === "host:register").length).toBe(registersBefore + 1);

      loop.stop();
    } finally {
      cleanup();
    }
  });

  const terminalCases: Array<{
    status: "cancelled" | "failed" | "timed_out";
    stream: "stdout" | "stderr";
    output: string;
    resumeRef: string;
    result: ProcessResult;
  }> = [
    {
      status: "cancelled",
      stream: "stderr",
      output: "resume-ref: cancelled-native-ref",
      resumeRef: "cancelled-native-ref",
      result: { exitCode: null, timedOut: false, cancelled: true, signal: "SIGTERM" },
    },
    {
      status: "failed",
      stream: "stdout",
      output: "resume-ref: failed-native-ref\n",
      resumeRef: "failed-native-ref",
      result: { exitCode: 1, timedOut: false, signal: null },
    },
    {
      status: "timed_out",
      stream: "stdout",
      output: "resume-ref: timeout-native-ref\n",
      resumeRef: "timeout-native-ref",
      result: { exitCode: null, timedOut: true, signal: "SIGTERM" },
    },
  ];

  for (const testCase of terminalCases) {
    it(`forwards and redacts a captured ref on ${testCase.status}`, async () => {
      const { config, cleanup } = await makeRepo();
      const serverMsgs: HostToServerMessage[] = [];
      const transport = createAcknowledgingLoopbackTransport({
        sendToServer: (message) => {
          serverMsgs.push(message);
        },
      });
      const fallbackRunner = new SpawnProcessRunner();
      const processRunner: ProcessRunner = {
        async run(options) {
          if (options.argv[0] !== "fake-cli") return await fallbackRunner.run(options);
          options.onChunk({ stream: testCase.stream, data: testCase.output });
          return testCase.result;
        },
      };
      const loop = new DaemonLoop({ config, transport, processRunner });

      try {
        await loop.start();
        transport.deliver({
          type: "session:assign",
          sessionId: `sess-${testCase.status}-resume-ref`,
          repositoryId: "demo",
          prompt: "continue",
          resolvedArgv: ["fake-cli"],
          resumeRefCapture: { stream: "either", linePrefix: "resume-ref: " },
          timeout: 30,
          worktreeId: "wt-1",
          ref: "main",
          assignedAt: new Date().toISOString(),
        });
        await loop.waitForIdle();

        const status = serverMsgs.find(
          (message): message is Extract<HostToServerMessage, { type: "session:status" }> =>
            message.type === "session:status" && message.status === testCase.status,
        );
        expect(status?.cliResumeRef).toBe(testCase.resumeRef);
        const logs = serverMsgs.filter(
          (message): message is Extract<HostToServerMessage, { type: "session:log" }> =>
            message.type === "session:log",
        );
        expect(logs.some((message) => message.content.includes(testCase.resumeRef))).toBe(false);
        expect(
          logs.some((message) => message.content.includes("[CLI resume reference redacted]")),
        ).toBe(true);
      } finally {
        loop.stop();
        cleanup();
      }
    });
  }
});
