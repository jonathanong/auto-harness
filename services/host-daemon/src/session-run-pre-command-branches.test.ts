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

function logs() {
  return [];
}

function streamer(output: ReturnType<typeof logs>) {
  return new LogStreamer("session", "attempt", (chunk) => output.push(chunk));
}

function setupRunner(result: Record<string, unknown>): ProcessRunner {
  return {
    async run() {
      return result;
    },
  };
}

async function runClaimed(
  over: Parameters<typeof baseAssign>[0] = {},
  options: {
    processRunner?: ProcessRunner;
    commandRunner?: ProcessRunner;
    claimed?: typeof claimed;
    signal?: AbortSignal;
    timedOut?: () => boolean;
    authorize?: (signal?: AbortSignal) => Promise<boolean>;
    defer?: boolean;
    profiles?: typeof testExecutionProfiles;
    environment?: NodeJS.ProcessEnv;
  } = {},
) {
  const output = logs();
  const processRunner = options.processRunner ?? setupRunner({ exitCode: 0, timedOut: false });
  return await runClaimedSession(
    processRunner,
    streamer(output),
    output,
    baseAssign(over),
    options.claimed ?? claimed,
    options.signal,
    options.timedOut ?? (() => false),
    () => 10_000,
    options.commandRunner ?? processRunner,
    options.environment ?? { PATH: process.env.PATH },
    options.profiles,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    options.authorize,
    options.defer ?? false,
  );
}

describe("pre-command recovery branch coverage", () => {
  it("defers failures from preflight policy, setup revalidation, and empty argv", async () => {
    let checks = 0;
    const policy = await runClaimed(
      {},
      {
        claimed: {
          ...claimed,
          currentExecutionTarget: async () => {
            checks += 1;
            throw new Error("policy changed");
          },
        },
        defer: true,
      },
    );
    expect(policy).toMatchObject({ status: "failed", errorMessage: "policy changed" });
    expect(policy.settleDeferredTerminalHook).toEqual(expect.any(Function));

    const setupPolicy = await runClaimed(
      { setupScript: "setup" },
      {
        claimed: {
          ...claimed,
          currentExecutionTarget: async () => {
            checks += 1;
            if (checks === 3) throw new Error("setup policy changed");
          },
        },
        processRunner: setupRunner({ exitCode: 0, timedOut: false, environment: {} }),
        defer: true,
      },
    );
    expect(setupPolicy).toMatchObject({ status: "failed", errorMessage: "setup policy changed" });
    expect(setupPolicy.settleDeferredTerminalHook).toEqual(expect.any(Function));

    const empty = await runClaimed(
      { resolvedArgv: [] },
      { defer: true, processRunner: setupRunner({ exitCode: 0, timedOut: false }) },
    );
    expect(empty).toMatchObject({ status: "failed", errorCode: "unknown_command_profile" });
    expect(empty.settleDeferredTerminalHook).toEqual(expect.any(Function));
  });

  it("covers setup cancellation, timeout, and nonzero exit", async () => {
    for (const [name, result, expected] of [
      ["timeout", { exitCode: null, timedOut: true }, "timed_out"],
      ["cancel", { exitCode: null, timedOut: false, cancelled: true }, "cancelled"],
      ["failure", { exitCode: 17, timedOut: false }, "failed"],
    ] as const) {
      const output = logs();
      const resultValue = await runSetupIfNeeded(
        setupRunner(result),
        streamer(output),
        output,
        baseAssign({ setupScript: `setup-${name}` }),
        claimed,
        name === "cancel" ? AbortSignal.abort() : undefined,
        () => name === "timeout",
        () => 10_000,
        { PATH: process.env.PATH },
        undefined,
        setupRunner(result),
        { PATH: process.env.PATH },
        true,
      );
      expect(resultValue.failure).toMatchObject({ status: expected });
      expect(resultValue.failure?.settleDeferredTerminalHook).toEqual(expect.any(Function));
    }
  });

  it("preserves timeout and cancellation after setup before command start", async () => {
    const timeout = new AbortController();
    timeout.abort();
    await expect(
      runClaimed({}, { signal: timeout.signal, timedOut: () => true, defer: true }),
    ).resolves.toMatchObject({ status: "timed_out" });
    await expect(
      runClaimed({}, { signal: timeout.signal, timedOut: () => false, defer: true }),
    ).resolves.toMatchObject({ status: "cancelled" });
  });

  it("covers authorization refusal, cancellation, and authorization errors", async () => {
    let commandRuns = 0;
    const commandRunner: ProcessRunner = {
      async run() {
        commandRuns += 1;
        return { exitCode: 0, timedOut: false };
      },
    };
    await expect(
      runClaimed({}, { commandRunner, authorize: async () => false }),
    ).resolves.toMatchObject({ status: "cancelled" });
    const aborted = new AbortController();
    await expect(
      runClaimed(
        {},
        {
          commandRunner,
          signal: aborted.signal,
          authorize: async () => {
            aborted.abort();
            return true;
          },
        },
      ),
    ).resolves.toMatchObject({ status: "cancelled" });
    await expect(
      runClaimed(
        {},
        {
          commandRunner,
          authorize: async () => {
            throw new Error("authorization unavailable");
          },
          defer: true,
        },
      ),
    ).resolves.toMatchObject({ status: "failed", errorMessage: "authorization unavailable" });
    expect(commandRuns).toBe(0);
  });
});
