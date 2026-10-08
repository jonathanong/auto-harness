import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { baseAssign } from "../test-helpers/session-runner-test-helpers.ts";
import { makeRunner } from "../test-helpers/session-runner-main-test-helpers.ts";
import { SessionOutputSpool } from "./session-output-spool.ts";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "harness-runner-output-lifecycle-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function readyJob(root: string): Promise<{ output: unknown } | undefined> {
  const jobs = await readdir(join(root, "jobs")).catch(() => [] as string[]);
  const ready = jobs.find((name) => name.endsWith(".ready"));
  if (!ready) return undefined;
  return JSON.parse(await readFile(join(root, "jobs", ready, "job.json"), "utf8")) as {
    output: unknown;
  };
}

function outputAssign(over: Parameters<typeof baseAssign>[0] = {}) {
  return baseAssign({
    repositoryId: "r1",
    worktreeId: null,
    sessionType: "scheduled",
    outputs: true,
    ...over,
  });
}

describe("SessionRunner output lifecycle", () => {
  it.each([
    ["completed", { exitCode: 0, timedOut: false, signal: null }],
    ["failed", { exitCode: 1, timedOut: false, signal: null }],
    ["cancelled", { exitCode: null, timedOut: false, cancelled: true, signal: "SIGTERM" }],
    ["timed_out", { exitCode: null, timedOut: true, signal: "SIGTERM" }],
  ] as const)("captures the final JSON for a %s command result", async (status, commandResult) => {
    const root = await tempRoot();
    const output = JSON.stringify({ status });
    const test = makeRunner({
      sessionOutputSpool: new SessionOutputSpool({ root }),
      commandResult,
      onCommand: async ({ env }) => {
        await writeFile(env.HARNESS_OUTPUT_FILE!, output, "utf8");
      },
    });

    const result = await test.runner.run(outputAssign());

    expect(result.status).toBe(status);
    expect(await readyJob(root)).toMatchObject({
      output: { state: "ready", jsonText: output },
    });
    expect(result.outputsJobId).toBeTruthy();
  });

  it("publishes outputs after a deferred terminal hook settles with runHook=true", async () => {
    const root = await tempRoot();
    let hookFinished = false;
    const test = makeRunner({
      sessionOutputSpool: new SessionOutputSpool({ root }),
      onHook: async ({ env }) => {
        await writeFile(env.HARNESS_OUTPUT_FILE!, '{"hook":true}', "utf8");
        hookFinished = true;
      },
    });
    test.throwSetup.value = true;
    const result = await test.runner.run(outputAssign({ setupScript: "setup" }), {
      deferPreCommandFailureHook: true,
    });

    expect(result.status).toBe("failed");
    expect(await readyJob(root)).toBeUndefined();
    expect(result.settleDeferredTerminalHook).toBeDefined();
    await result.settleDeferredTerminalHook!(true);

    expect(hookFinished).toBe(true);
    expect(await readyJob(root)).toMatchObject({
      output: { state: "ready", jsonText: '{"hook":true}' },
    });
    expect(result.outputsJobId).toBeTruthy();
  });

  it("discards the staged attempt when a deferred infrastructure retry skips the hook", async () => {
    const root = await tempRoot();
    const test = makeRunner({ sessionOutputSpool: new SessionOutputSpool({ root }) });
    test.throwSetup.value = true;
    const result = await test.runner.run(outputAssign({ setupScript: "setup" }), {
      deferPreCommandFailureHook: true,
    });
    const attemptDirsBeforeSettle = await readdir(join(root, "attempts"));
    expect(attemptDirsBeforeSettle).toHaveLength(1);

    await result.settleDeferredTerminalHook!(false);

    expect(test.hooks).toEqual([]);
    expect(await readyJob(root)).toBeUndefined();
    expect(await readdir(join(root, "attempts"))).toEqual([]);
  });

  it("keeps a deferred retry outcome when discarding its staged attempt fails", async () => {
    const root = await tempRoot();
    const spool = new SessionOutputSpool({ root });
    const messages: string[] = [];
    const test = makeRunner({
      sessionOutputSpool: {
        async begin(sessionId: string, attemptId: string) {
          const attempt = await spool.begin(sessionId, attemptId);
          return { ...attempt, discard: async () => Promise.reject(new Error("disk busy")) };
        },
      } as unknown as SessionOutputSpool,
      onLog: (chunk) => messages.push(chunk.content),
    });
    test.throwSetup.value = true;
    const result = await test.runner.run(outputAssign({ setupScript: "setup" }), {
      deferPreCommandFailureHook: true,
    });

    await result.settleDeferredTerminalHook!(false);

    expect(result.status).toBe("failed");
    expect(messages).toContain("session output discard failed: disk busy");
    expect(await readyJob(root)).toBeUndefined();
  });

  it("keeps command outcome when output staging or capture fails", async () => {
    const stagingFailure = {
      async begin() {
        throw new Error("staging unavailable");
      },
    } as unknown as SessionOutputSpool;
    const staged = makeRunner({ sessionOutputSpool: stagingFailure });
    const stagedResult = await staged.runner.run(outputAssign());
    expect(stagedResult.status).toBe("completed");

    const captureRoot = await tempRoot();
    const realSpool = new SessionOutputSpool({ root: captureRoot });
    const captureFailure = {
      async begin(sessionId: string, attemptId: string) {
        const attempt = await realSpool.begin(sessionId, attemptId);
        return { ...attempt, capture: async () => Promise.reject(new Error("disk full")) };
      },
    } as unknown as SessionOutputSpool;
    const capture = makeRunner({ sessionOutputSpool: captureFailure });
    const captureResult = await capture.runner.run(outputAssign());

    expect(captureResult.status).toBe("completed");
    expect(captureResult.outputsJobId).toBeUndefined();
  });

  it("captures a final output when the command runner throws", async () => {
    const root = await tempRoot();
    const test = makeRunner({
      sessionOutputSpool: new SessionOutputSpool({ root }),
      onCommand: async ({ env }) => {
        await writeFile(env.HARNESS_OUTPUT_FILE!, '{"beforeError":true}', "utf8");
      },
    });
    test.throwPrimary.value = true;

    const result = await test.runner.run(outputAssign());

    expect(result.status).toBe("failed");
    expect(await readyJob(root)).toMatchObject({
      output: { state: "ready", jsonText: '{"beforeError":true}' },
    });
  });

  it("captures an attempt before propagating an unexpected runner error", async () => {
    const root = await tempRoot();
    const test = makeRunner({
      sessionOutputSpool: new SessionOutputSpool({ root }),
      now: () => {
        throw new Error("clock unavailable");
      },
    });

    await expect(test.runner.run(outputAssign())).rejects.toThrow("clock unavailable");

    expect(await readyJob(root)).toMatchObject({ output: { state: "none" } });
  });
});
