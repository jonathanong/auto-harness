import { describe, expect, it } from "vitest";

import type { ProcessRunner } from "./executor.ts";
import { LogStreamer } from "./log-streamer.ts";
import { runClaimedSession } from "./session-run-claimed.ts";
import { runSetupIfNeeded } from "./session-run-setup.ts";
import { baseAssign } from "../test-helpers/session-runner-test-helpers.ts";

const claimed = {
  repository: { id: "repo-1", path: "/repo", defaultBranch: "main", worktrees: [] },
  worktree: { id: "wt-1", name: "wt", path: "/wt", labels: [] },
  cwd: "/wt",
  currentHookTarget: async () => null,
};

function run(result: Record<string, unknown>, emit?: string): ProcessRunner {
  return {
    async run(options) {
      if (emit) options.onChunk({ stream: "stdout", data: emit });
      return result;
    },
  };
}

async function claimedRun(
  over: Parameters<typeof baseAssign>[0],
  commandRunner: ProcessRunner,
  environment: NodeJS.ProcessEnv = { PATH: process.env.PATH },
) {
  const logs: never[] = [];
  const processRunner = run({ exitCode: 0, timedOut: false });
  return await runClaimedSession(
    processRunner,
    new LogStreamer("session", "attempt", (chunk) => (logs as unknown[]).push(chunk)),
    logs,
    baseAssign(over),
    claimed,
    undefined,
    () => false,
    () => 10_000,
    commandRunner,
    environment,
  );
}

describe("pre-command credential and outcome branches", () => {
  it("redacts a session credential in a completed command transcript", async () => {
    const result = await claimedRun(
      {
        sessionApiKey: "hns_session_secret",
        resumeRefCapture: { stream: "stdout", linePrefix: "resume: " },
      },
      run(
        { exitCode: 0, timedOut: false, agentSummary: "hns_session_secret" },
        "hns_session_secret\nresume: native-ref\n",
      ),
    );
    expect(result).toMatchObject({ status: "completed", cliResumeRef: "native-ref" });
    expect(result.logs.some((chunk) => chunk.content.includes("hns_session_secret"))).toBe(false);
  });

  it("preserves resume references and summaries for timed-out, cancelled, and failed commands", async () => {
    const policy = { stream: "stdout" as const, linePrefix: "resume: " };
    const timedOut = await claimedRun(
      { resumeRefCapture: policy },
      run({ exitCode: null, timedOut: true, agentSummary: "timed out" }, "resume: timeout-ref\n"),
    );
    expect(timedOut).toMatchObject({ status: "timed_out", cliResumeRef: "timeout-ref" });

    const cancelled = await claimedRun(
      { resumeRefCapture: policy },
      run(
        { exitCode: null, timedOut: false, cancelled: true, agentSummary: "cancelled" },
        "resume: cancel-ref\n",
      ),
    );
    expect(cancelled).toMatchObject({ status: "cancelled", cliResumeRef: "cancel-ref" });

    const failed = await claimedRun(
      { resumeRefCapture: policy },
      run({ exitCode: 1, timedOut: false, agentSummary: "failed" }, "resume: failure-ref\n"),
    );
    expect(failed).toMatchObject({ status: "failed", cliResumeRef: "failure-ref" });
  });

  it("takes the non-deferred setup failure branches", async () => {
    const invalidEnvironment = await claimedRun({}, run({ exitCode: 0, timedOut: false }), {
      HARNESS_CHILD_ENV_ALLOWLIST: "bad=value",
    });
    expect(invalidEnvironment).toMatchObject({ status: "failed", errorCode: "setup_failed" });

    let checks = 0;
    const setupRevalidation = await runClaimedSession(
      run({ exitCode: 0, timedOut: false, environment: {} }),
      new LogStreamer("session", "attempt", () => undefined),
      [],
      baseAssign({ setupScript: "setup" }),
      {
        ...claimed,
        currentExecutionTarget: async () => {
          checks += 1;
          if (checks === 3) throw new Error("setup policy changed");
        },
      },
      undefined,
      () => false,
      () => 10_000,
      run({ exitCode: 0, timedOut: false, environment: {} }),
    );
    expect(setupRevalidation).toMatchObject({
      status: "failed",
      errorMessage: "setup policy changed",
    });
  });

  it("covers a non-deferred cancelled setup step", async () => {
    const output: never[] = [];
    const result = await runSetupIfNeeded(
      run({ exitCode: null, timedOut: false, cancelled: true }),
      new LogStreamer("session", "attempt", (chunk) => (output as unknown[]).push(chunk)),
      output,
      baseAssign({ setupScript: "setup" }),
      claimed,
      undefined,
      () => false,
      () => 10_000,
      { PATH: process.env.PATH },
    );
    expect(result.failure).toMatchObject({ status: "cancelled" });
    expect(result.failure).not.toHaveProperty("settleDeferredTerminalHook");
  });
});
