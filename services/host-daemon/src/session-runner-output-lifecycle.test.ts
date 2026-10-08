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
    await result.settleDeferredTerminalHook!(true);
    expect(test.hooks).toHaveLength(1);
    expect(await readyJob(root)).toMatchObject({
      output: { state: "ready", jsonText: '{"hook":true}' },
    });
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
    await result.settleDeferredTerminalHook!(false);
    expect(await readyJob(root)).toBeUndefined();
  });
});
