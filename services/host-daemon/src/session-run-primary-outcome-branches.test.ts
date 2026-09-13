import { describe, expect, it } from "vitest";

import type { ProcessRunner } from "./executor.ts";
import { LogStreamer } from "./log-streamer.ts";
import { runClaimedSession } from "./session-run-claimed.ts";
import { runSetupIfNeeded } from "./session-run-setup.ts";
import { baseAssign, testExecutionProfiles } from "../test-helpers/session-runner-test-helpers.ts";

const claimed = {
  repository: { id: "repo-1", path: "/repo", defaultBranch: "main", worktrees: [] },
  worktree: { id: "wt-1", name: "wt", path: "/wt", labels: [] },
  cwd: "/wt",
  currentHookTarget: async () => null,
};

function runner(result: Record<string, unknown>): ProcessRunner {
  return {
    async run() {
      return result;
    },
  };
}

async function runClaimed(
  over: Parameters<typeof baseAssign>[0] = {},
  options: {
    commandRunner?: ProcessRunner;
    defer?: boolean;
    profiles?: typeof testExecutionProfiles;
  } = {},
) {
  const logs: never[] = [];
  const processRunner = runner({ exitCode: 0, timedOut: false });
  return await runClaimedSession(
    processRunner,
    new LogStreamer("session", "attempt", (chunk) => (logs as unknown[]).push(chunk)),
    logs,
    baseAssign(over),
    claimed,
    undefined,
    () => false,
    () => 10_000,
    options.commandRunner ?? processRunner,
    { PATH: process.env.PATH },
    options.profiles,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    options.defer ?? false,
  );
}

describe("pre-command primary outcome branches", () => {
  it("returns the environment from a successful setup script", async () => {
    const output: never[] = [];
    const setup = await runSetupIfNeeded(
      runner({ exitCode: 0, timedOut: false, environment: { SETUP: "yes" } }),
      new LogStreamer("session", "attempt", (chunk) => (output as unknown[]).push(chunk)),
      output,
      baseAssign({ setupScript: "setup" }),
      claimed,
      undefined,
      () => false,
      () => 10_000,
      { PATH: process.env.PATH },
    );
    expect(setup.failure).toBeNull();
    expect(setup.environment).toMatchObject({ SETUP: "yes" });
  });

  it("fails closed for an unavailable provider profile and defers the hook", async () => {
    await expect(
      runClaimed({ providerAccountId: "missing", resolvedArgv: ["cli"] }, { defer: true }),
    ).resolves.toMatchObject({
      status: "failed",
      errorMessage: "execution profile unavailable for missing",
    });
  });

  it("covers completed, timed out, cancelled, and failed command outcomes", async () => {
    const outcomes = [
      { result: { exitCode: 0, timedOut: false }, expected: "completed" },
      { result: { exitCode: null, timedOut: true }, expected: "timed_out" },
      { result: { exitCode: null, timedOut: false, cancelled: true }, expected: "cancelled" },
      { result: { exitCode: 1, timedOut: false }, expected: "failed" },
    ] as const;
    for (const outcome of outcomes) {
      await expect(
        runClaimed({}, { commandRunner: runner(outcome.result), profiles: testExecutionProfiles }),
      ).resolves.toMatchObject({ status: outcome.expected });
    }
  });

  it("converts a command-runner rejection into a setup failure", async () => {
    await expect(
      runClaimed(
        {},
        {
          commandRunner: {
            async run() {
              throw new Error("command spawn failed");
            },
          },
        },
      ),
    ).resolves.toMatchObject({ status: "failed", errorMessage: "command spawn failed" });
  });
});
