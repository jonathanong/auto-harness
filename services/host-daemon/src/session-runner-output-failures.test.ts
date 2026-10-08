import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { baseAssign } from "../test-helpers/session-runner-test-helpers.ts";
import { deferred, makeRunner } from "../test-helpers/session-runner-main-test-helpers.ts";
import { SessionOutputSpool } from "./session-output-spool.ts";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "harness-runner-output-failures-"));
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

describe("SessionRunner output failures", () => {
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

  it("keeps a deferred failure result when terminal-hook output capture fails", async () => {
    const root = await tempRoot();
    const messages: string[] = [];
    const test = makeRunner({
      sessionOutputSpool: new SessionOutputSpool({ root }),
      onHook: async ({ env }) => {
        await writeFile(env.HARNESS_OUTPUT_FILE!, '{"hook":true}', "utf8");
      },
      onLog: (chunk) => messages.push(chunk.content),
    });
    test.throwSetup.value = true;
    const result = await test.runner.run(outputAssign({ setupScript: "setup" }), {
      deferPreCommandFailureHook: true,
    });
    await writeFile(join(root, "jobs"), "blocks spool persistence", "utf8");

    await result.settleDeferredTerminalHook!(true);

    expect(result.status).toBe("failed");
    expect(result.outputsJobId).toBeUndefined();
    expect(messages).toEqual(
      expect.arrayContaining([expect.stringContaining("session output capture failed:")]),
    );
  });

  it("keeps the command outcome when output staging or capture fails", async () => {
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

  it("captures output completed before the command runner throws", async () => {
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

  it("discards staged outputs when checkout cancellation settles without a terminal hook", async () => {
    const root = await tempRoot();
    const checkoutStarted = deferred<void>();
    const test = makeRunner({
      sessionOutputSpool: new SessionOutputSpool({ root }),
      onCheckout: ({ signal }) =>
        new Promise<void>((_resolve, reject) => {
          checkoutStarted.resolve();
          signal?.addEventListener("abort", () => reject(new Error("checkout aborted")), {
            once: true,
          });
        }),
    });
    test.config.repositories[0]!.worktrees.push({
      id: "wt-1",
      name: "test",
      path: "/repo-1/wt-1",
      labels: [],
    });
    const controller = new AbortController();
    const running = test.runner.run(outputAssign({ worktreeId: "wt-1" }), {
      signal: controller.signal,
      deferPreCommandFailureHook: true,
    });
    await checkoutStarted.promise;
    controller.abort();

    const result = await running;

    expect(result.status).toBe("cancelled");
    expect(result.settleDeferredTerminalHook).toBeDefined();
    expect(await readyJob(root)).toBeUndefined();
    await result.settleDeferredTerminalHook!(false);
    expect(await readyJob(root)).toBeUndefined();
    expect(await readdir(join(root, "attempts"))).toEqual([]);
  });

  it("propagates an unexpected runner error without an output-enabled assignment", async () => {
    const test = makeRunner({
      now: () => {
        throw new Error("clock unavailable");
      },
    });

    await expect(test.runner.run(outputAssign({ outputs: false }))).rejects.toThrow(
      "clock unavailable",
    );
  });
});
