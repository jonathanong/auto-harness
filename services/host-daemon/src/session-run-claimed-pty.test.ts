import { describe, expect, it } from "vitest";

import type { ProcessRunner } from "./executor.ts";
import { LogStreamer } from "./log-streamer.ts";
import { runClaimedSession } from "./session-run-claimed.ts";
import { baseAssign } from "../test-helpers/session-runner-test-helpers.ts";

const claimed = {
  repository: { id: "repo-1", path: "/repo", defaultBranch: "main", worktrees: [] },
  worktree: { id: "wt-1", name: "wt", path: "/wt", labels: [] },
  cwd: "/wt",
};

describe("claimed session PTY output", () => {
  it("captures and redacts stderr-scoped resume references from the merged stream", async () => {
    const logs = [];
    const systemRunner: ProcessRunner = {
      async run() {
        return { exitCode: 0, timedOut: false, signal: null };
      },
    };
    const commandRunner: ProcessRunner = {
      outputStreams: "merged",
      async run(options) {
        options.onChunk({ stream: "stdout", data: "resume: opaque-native-ref\r\nready\r\n" });
        return { exitCode: 0, timedOut: false, signal: null };
      },
    };

    const outcome = await runClaimedSession(
      systemRunner,
      new LogStreamer("session-1", "attempt-1", (chunk) => logs.push(chunk)),
      logs,
      baseAssign({ resumeRefCapture: { stream: "stderr", linePrefix: "resume: " } }),
      claimed,
      undefined,
      () => false,
      () => 1_000,
      commandRunner,
    );

    expect(outcome).toMatchObject({ status: "completed", cliResumeRef: "opaque-native-ref" });
    expect(logs.map((chunk) => chunk.content).join("\n")).toContain(
      "[CLI resume reference redacted]\n",
    );
    expect(logs.some((chunk) => chunk.content.includes("opaque-native-ref"))).toBe(false);
  });

  it("does not spawn until the command-start authorization callback resolves", async () => {
    const logs = [];
    const systemRunner: ProcessRunner = {
      async run() {
        return { exitCode: 0, timedOut: false, signal: null };
      },
    };
    let authorize!: () => void;
    const authorization = new Promise<boolean>((resolve) => {
      authorize = () => resolve(true);
    });
    let authorizationEntered!: () => void;
    const authorizationStarted = new Promise<void>((resolve) => {
      authorizationEntered = resolve;
    });
    let commandRuns = 0;
    const commandRunner: ProcessRunner = {
      async run() {
        commandRuns += 1;
        return { exitCode: 0, timedOut: false, signal: null };
      },
    };
    const work = runClaimedSession(
      systemRunner,
      new LogStreamer("session-1", "attempt-1", (chunk) => logs.push(chunk)),
      logs,
      baseAssign(),
      claimed,
      undefined,
      () => false,
      () => 1_000,
      commandRunner,
      process.env,
      undefined,
      undefined,
      async () => {
        authorizationEntered();
        return await authorization;
      },
    );

    await authorizationStarted;
    expect(commandRuns).toBe(0);
    authorize();
    await expect(work).resolves.toMatchObject({ status: "completed" });
    expect(commandRuns).toBe(1);
  });

  it("reports cancellation from command-start authorization without spawning", async () => {
    let commandRuns = 0;
    let hookRuns = 0;
    const controller = new AbortController();
    const commandRunner: ProcessRunner = {
      async run() {
        commandRuns += 1;
        return { exitCode: 0, timedOut: false, signal: null };
      },
    };
    const logs = [];
    const outcome = await runClaimedSession(
      {
        async run(options) {
          if (options.argv[1] === "/hook.sh") hookRuns += 1;
          return { exitCode: 0, timedOut: false, signal: null };
        },
      },
      new LogStreamer("session-1", "attempt-1", (chunk) => logs.push(chunk)),
      logs,
      baseAssign(),
      {
        ...claimed,
        currentHookTarget: async () => ({
          cwd: claimed.cwd,
          repository: { terminalHookScript: "/hook.sh" },
        }),
      },
      controller.signal,
      () => false,
      () => 1_000,
      commandRunner,
      process.env,
      undefined,
      undefined,
      async () => {
        controller.abort();
        return false;
      },
    );

    expect(outcome).toMatchObject({ status: "cancelled" });
    expect(commandRuns).toBe(0);
    expect(hookRuns).toBe(0);
  });

  it("reports timeout when command-start authorization observes an expired abort", async () => {
    let commandRuns = 0;
    const logs = [];
    const outcome = await runClaimedSession(
      {
        async run() {
          return { exitCode: 0, timedOut: false, signal: null };
        },
      },
      new LogStreamer("session-1", "attempt-1", (chunk) => logs.push(chunk)),
      logs,
      baseAssign(),
      claimed,
      AbortSignal.abort(),
      () => true,
      () => 1_000,
      {
        async run() {
          commandRuns += 1;
          return { exitCode: 0, timedOut: false, signal: null };
        },
      },
      process.env,
      undefined,
      undefined,
      async () => false,
    );

    expect(outcome).toMatchObject({ status: "timed_out", exitCode: null });
    expect(commandRuns).toBe(0);
  });
});
