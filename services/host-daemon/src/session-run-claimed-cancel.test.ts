import { describe, expect, it } from "vitest";

import type { ProcessRunner } from "./executor.ts";
import { LogStreamer } from "./log-streamer.ts";
import { runClaimedSession } from "./session-run-claimed.ts";
import { baseAssign } from "./session-runner-test-helpers.ts";

const claimed = {
  repository: { id: "repo-1", path: "/repo", defaultBranch: "main", worktrees: [] },
  worktree: { id: "wt-1", name: "wt", path: "/wt", labels: [] },
  cwd: "/wt",
};

describe("claimed session cancellation", () => {
  it("honors a cancellation already present before setup is spawned", async () => {
    const controller = new AbortController();
    controller.abort();
    const logs = [];
    await expect(
      runClaimedSession(
        cancellableRunner,
        new LogStreamer("s", (chunk) => logs.push(chunk)),
        logs,
        baseAssign({ setupScript: "slow" }),
        claimed,
        controller.signal,
        () => false,
        () => 100,
      ),
    ).resolves.toMatchObject({ status: "cancelled" });
  });

  it("does not start the primary command after cancellation without setup", async () => {
    const controller = new AbortController();
    controller.abort();
    let started = false;
    const logs = [];
    await expect(
      runClaimedSession(
        {
          async run() {
            started = true;
            return { exitCode: 0, timedOut: false, signal: null };
          },
        },
        new LogStreamer("s", (chunk) => logs.push(chunk)),
        logs,
        baseAssign(),
        claimed,
        controller.signal,
        () => false,
        () => 100,
      ),
    ).resolves.toMatchObject({ status: "cancelled" });
    expect(started).toBe(false);
  });

  it("reports timeout when setup is entered after the deadline", async () => {
    const controller = new AbortController();
    controller.abort();
    const logs = [];
    await expect(
      runClaimedSession(
        cancellableRunner,
        new LogStreamer("s", (chunk) => logs.push(chunk)),
        logs,
        baseAssign({ setupScript: "slow" }),
        claimed,
        controller.signal,
        () => true,
        () => 100,
      ),
    ).resolves.toMatchObject({ status: "timed_out" });
  });

  it("runs a claimed command without a cancellation signal", async () => {
    const logs = [];
    await expect(
      runClaimedSession(
        {
          async run() {
            return { exitCode: 0, timedOut: false, signal: null };
          },
        },
        new LogStreamer("s", (chunk) => logs.push(chunk)),
        logs,
        baseAssign(),
        claimed,
        undefined,
        () => false,
        () => 100,
      ),
    ).resolves.toMatchObject({ status: "completed" });
  });

  it("reports timeout when already aborted without setup", async () => {
    const logs = [];
    await expect(
      runClaimedSession(
        cancellableRunner,
        new LogStreamer("s", (chunk) => logs.push(chunk)),
        logs,
        baseAssign(),
        claimed,
        AbortSignal.abort(),
        () => true,
        () => 100,
      ),
    ).resolves.toMatchObject({ status: "timed_out" });
  });

  it("retains a captured resume reference on a usage-limit outcome", async () => {
    const logs = [];
    await expect(
      runClaimedSession(
        {
          async run(options) {
            options.onChunk({
              stream: "stdout",
              data: "resume: native-1\nError: insufficient_quota for request",
            });
            return { exitCode: 1, timedOut: false, signal: null };
          },
        },
        new LogStreamer("s", (chunk) => logs.push(chunk)),
        logs,
        baseAssign({
          resolvedArgv: ["codex", "exec"],
          providerAccountId: "acct-1",
          resumeRefCapture: { stream: "stdout", linePrefix: "resume: " },
        }),
        claimed,
        undefined,
        () => false,
        () => 100,
      ),
    ).resolves.toMatchObject({
      status: "failed",
      errorCode: "usage_limit",
      cliResumeRef: "native-1",
    });
  });

  it("preserves CLI usage across every terminal process outcome", async () => {
    const usage = {
      kind: "delta" as const,
      sequence: 1,
      inputTokens: "2",
      observedAt: "2026-01-01T00:00:00.000Z",
      source: "cli" as const,
    };
    for (const scenario of [
      { expected: "timed_out", result: { exitCode: null, timedOut: true, signal: "SIGTERM" } },
      {
        expected: "cancelled",
        result: { exitCode: null, timedOut: false, cancelled: true, signal: "SIGTERM" },
      },
      { expected: "completed", result: { exitCode: 0, timedOut: false, signal: null } },
      { expected: "failed", result: { exitCode: 1, timedOut: false, signal: null } },
      {
        expected: "failed",
        output: "usage limit reached",
        result: { exitCode: 1, timedOut: false, signal: null },
      },
    ] as const) {
      const logs = [];
      const outcome = await runClaimedSession(
        {
          async run(options) {
            if (scenario.output) options.onChunk({ stream: "stdout", data: scenario.output });
            return { ...scenario.result, usage };
          },
        },
        new LogStreamer("s", (chunk) => logs.push(chunk)),
        logs,
        baseAssign(),
        claimed,
        undefined,
        () => false,
        () => 100,
      );
      expect(outcome).toMatchObject({ status: scenario.expected, usage });
    }
  });
});

const cancellableRunner: ProcessRunner = {
  async run(options) {
    const isSetup = options.argv[1] === "-c" && options.argv[3] === "auto-harness-setup";
    if (!isSetup) return { exitCode: 0, timedOut: false, signal: null };
    return await new Promise((resolve) => {
      options.signal?.addEventListener(
        "abort",
        () => resolve({ exitCode: null, timedOut: false, cancelled: true, signal: "SIGTERM" }),
        { once: true },
      );
    });
  },
};
