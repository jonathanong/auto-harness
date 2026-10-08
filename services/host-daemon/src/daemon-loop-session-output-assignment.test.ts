import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { HostToServerMessage } from "@auto-harness/shared";

import { DaemonLoop } from "./daemon-loop.ts";
import type { ProcessRunner } from "./executor.ts";
import {
  createAcknowledgingLoopbackTransport,
  makeRepo,
} from "../test-helpers/daemon-loop-test-helpers.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("DaemonLoop output-enabled assignment", () => {
  it("captures output, reports terminal status, and wakes the publisher", async () => {
    const { config, cleanup } = await makeRepo();
    const outputRoot = await mkdtemp(join(tmpdir(), "ah-loop-output-assignment-"));
    roots.push(outputRoot);
    const serverMessages: HostToServerMessage[] = [];
    const commandRunner: ProcessRunner = {
      async run(options) {
        const outputFile = options.env?.HARNESS_OUTPUT_FILE;
        if (outputFile) await writeFile(outputFile, '{"daemonLoop":true}', "utf8");
        return { exitCode: 0, timedOut: false, signal: null };
      },
    };
    const transport = createAcknowledgingLoopbackTransport({
      sendToServer: (message) => serverMessages.push(message),
    });
    const loop = new DaemonLoop({
      config,
      transport,
      commandRunner,
      sessionOutputsDir: outputRoot,
    });
    try {
      await loop.start();
      const spool = (loop as unknown as { sessionOutputSpool: { wake(): void } })
        .sessionOutputSpool;
      const wake = spool.wake.bind(spool);
      let wakeCalls = 0;
      spool.wake = () => {
        wakeCalls += 1;
        wake();
      };
      transport.deliver({
        type: "session:assign",
        sessionId: "output-enabled-loop",
        attemptId: "attempt-output-enabled-loop",
        sessionType: "scheduled",
        repositoryId: "demo",
        prompt: "run task",
        resolvedArgv: ["true"],
        timeout: 30,
        worktreeId: null,
        ref: "main",
        outputs: true,
        assignedAt: new Date().toISOString(),
      });
      await loop.waitForIdle();

      expect(
        serverMessages.some(
          (message) =>
            message.type === "session:status" &&
            message.sessionId === "output-enabled-loop" &&
            message.status === "completed",
        ),
      ).toBe(true);
      expect(wakeCalls).toBeGreaterThanOrEqual(2);
      const jobDirs = await readdir(join(outputRoot, "jobs"));
      expect(jobDirs).toHaveLength(1);
      const saved = JSON.parse(
        await readFile(join(outputRoot, "jobs", jobDirs[0]!, "job.json"), "utf8"),
      ) as { output: { state: string; jsonText?: string } };
      expect(saved.output).toEqual({
        state: "ready",
        jsonText: '{"daemonLoop":true}',
        sha256: expect.any(String),
      });
    } finally {
      loop.stop();
      cleanup();
    }
  });
});
