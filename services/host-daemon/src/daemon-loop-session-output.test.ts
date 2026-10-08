import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DaemonLoop, createLoopbackTransport } from "./daemon-loop.ts";
import { SessionOutputSpool } from "./session-output-spool.ts";
import { makeRepo } from "../test-helpers/daemon-loop-test-helpers.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function outputRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ah-loop-session-output-"));
  roots.push(root);
  return root;
}

function handoff(sessionId: string, outputAttemptId?: string) {
  return {
    type: "session:terminal-hook" as const,
    handoffId: `${sessionId}-handoff`,
    sessionId,
    repositoryId: "demo",
    worktreeId: "wt-1",
    status: "failed" as const,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    outputs: true,
    ...(outputAttemptId ? { outputAttemptId } : {}),
  };
}

function terminalHookCaller(loop: DaemonLoop) {
  return loop as unknown as {
    runTerminalHookForClaim(
      message: ReturnType<typeof handoff>,
      claim: { currentHookTarget: () => Promise<unknown> },
      expiresAtMs: number,
    ): Promise<unknown>;
  };
}

describe("DaemonLoop session output handoff", () => {
  it("recovers the staged attempt and captures output after the deferred hook", async () => {
    const { config, cleanup } = await makeRepo();
    const root = await outputRoot();
    const hookEnvironments: NodeJS.ProcessEnv[] = [];
    const processRunner = {
      async run(options: { argv: string[]; cwd: string; env?: NodeJS.ProcessEnv }) {
        if (options.argv[0] === "/bin/sh") {
          hookEnvironments.push(options.env ?? {});
          const outputFile = options.env?.HARNESS_OUTPUT_FILE;
          if (outputFile) await writeFile(outputFile, '{"afterHook":true}', "utf8");
        }
        return { exitCode: 0, timedOut: false, signal: null };
      },
    };
    const loop = new DaemonLoop({
      config,
      transport: createLoopbackTransport({ sendToServer: () => undefined }),
      processRunner,
      sessionOutputsDir: root,
    });
    try {
      await loop.start();
      const attempt = await new SessionOutputSpool({ root }).begin("session-hook", "attempt-hook");
      const claim = {
        currentHookTarget: async () => ({
          cwd: config.repositories[0]!.path,
          repository: config.repositories[0]!,
        }),
      };

      const result = await terminalHookCaller(loop).runTerminalHookForClaim(
        handoff("session-hook", "attempt-hook"),
        claim,
        Date.now() + 60_000,
      );

      expect(result).toMatchObject({ summarySource: "harness" });
      expect(hookEnvironments).toHaveLength(1);
      expect(hookEnvironments[0]?.HARNESS_OUTPUT_FILE).toBe(attempt.env.HARNESS_OUTPUT_FILE);
      const jobs = await readdir(join(root, "jobs"));
      expect(jobs).toHaveLength(1);
      const saved = JSON.parse(
        await readFile(join(root, "jobs", jobs[0]!, "job.json"), "utf8"),
      ) as { output: { state: string; jsonText?: string } };
      expect(saved.output).toEqual({
        state: "ready",
        jsonText: '{"afterHook":true}',
        sha256: expect.any(String),
      });
    } finally {
      loop.stop();
      cleanup();
    }
  });

  it("keeps the hook result and reports a failed capture when recovery storage is unavailable", async () => {
    const { config, cleanup } = await makeRepo();
    const root = await outputRoot();
    const lines: string[] = [];
    const loop = new DaemonLoop({
      config,
      transport: createLoopbackTransport({ sendToServer: () => undefined }),
      processRunner: {
        async run(options: { argv: string[]; cwd: string; env?: NodeJS.ProcessEnv }) {
          if (options.argv[0] === "/bin/sh") {
            const outputFile = options.env?.HARNESS_OUTPUT_FILE;
            if (outputFile) await writeFile(outputFile, '{"capture":"fails"}', "utf8");
          }
          return { exitCode: 0, timedOut: false, signal: null };
        },
      },
      sessionOutputsDir: root,
      onLog: (line) => lines.push(line),
    });
    try {
      await loop.start();
      const attempt = await new SessionOutputSpool({ root }).begin(
        "session-capture-failure",
        "attempt",
      );
      await rm(join(root, "jobs"), { recursive: true, force: true });
      await writeFile(join(root, "jobs"), "blocks directory creation", "utf8");
      const claim = {
        currentHookTarget: async () => ({
          cwd: config.repositories[0]!.path,
          repository: config.repositories[0]!,
        }),
      };

      const result = await terminalHookCaller(loop).runTerminalHookForClaim(
        handoff("session-capture-failure", "attempt"),
        claim,
        Date.now() + 60_000,
      );

      expect(result).toMatchObject({ summarySource: "harness" });
      expect(attempt.jobId).toMatch(/^[a-f0-9]{64}$/);
      expect(lines.some((line) => line.includes("deferred session output capture failed"))).toBe(
        true,
      );
    } finally {
      loop.stop();
      cleanup();
    }
  });

  it("runs a terminal hook normally when its deferred output attempt is absent", async () => {
    const { config, cleanup } = await makeRepo();
    const root = await outputRoot();
    const hookEnvironments: NodeJS.ProcessEnv[] = [];
    const loop = new DaemonLoop({
      config,
      transport: createLoopbackTransport({ sendToServer: () => undefined }),
      processRunner: {
        async run(options: { argv: string[]; cwd: string; env?: NodeJS.ProcessEnv }) {
          if (options.argv[0] === "/bin/sh") hookEnvironments.push(options.env ?? {});
          return { exitCode: 0, timedOut: false, signal: null };
        },
      },
      sessionOutputsDir: root,
    });
    try {
      await loop.start();
      const claim = {
        currentHookTarget: async () => ({
          cwd: config.repositories[0]!.path,
          repository: config.repositories[0]!,
        }),
      };

      const result = await terminalHookCaller(loop).runTerminalHookForClaim(
        handoff("session-missing-attempt"),
        claim,
        Date.now() + 60_000,
      );

      expect(result).toMatchObject({ summarySource: "harness" });
      expect(hookEnvironments).toHaveLength(1);
      expect(hookEnvironments[0]?.HARNESS_OUTPUT_FILE).toBeUndefined();
      await expect(readdir(join(root, "jobs"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      loop.stop();
      cleanup();
    }
  });
});
