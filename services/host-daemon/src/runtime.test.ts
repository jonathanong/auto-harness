import { describe, expect, it } from "vitest";

import { parseDaemonConfig } from "./config.ts";
import type { ProcessRunner } from "./executor.ts";
import { ensureDaemonReady, runAssignedSession } from "./runtime.ts";

const config = parseDaemonConfig({
  hostId: "a1",
  commandProfiles: { echo: { argv: ["echo"], appendPrompt: true } },
  repositories: [
    {
      id: "repo-1",
      path: "/repo",
      defaultBranch: "main",
      worktrees: [{ id: "wt-1", name: "wt-1", path: "/repo/wt-1", labels: [] }],
    },
  ],
});

describe("runtime helpers", () => {
  it("ensureDaemonReady uses git client", async () => {
    const calls: string[] = [];
    const runner: ProcessRunner = {
      async run(opts) {
        calls.push(opts.argv.join(" "));
        if (opts.argv.includes("--version")) {
          opts.onChunk({ stream: "stdout", data: "git version 2.36.0\n" });
          return { exitCode: 0, timedOut: false, signal: null };
        }
        if (opts.argv.includes("rev-parse")) {
          return { exitCode: 0, timedOut: false, signal: null };
        }
        if (opts.argv.includes("list")) {
          opts.onChunk({
            stream: "stdout",
            data: "worktree /repo/wt-1\n",
          });
          return { exitCode: 0, timedOut: false, signal: null };
        }
        return { exitCode: 0, timedOut: false, signal: null };
      },
    };
    await ensureDaemonReady(config, runner);
    expect(calls.some((c) => c.includes("rev-parse"))).toBe(true);
  });

  it("returns an unready runtime report without initializing worktrees", async () => {
    const calls: string[] = [];
    const runner: ProcessRunner = {
      async run(opts) {
        calls.push(opts.argv.join(" "));
        return { exitCode: 1, timedOut: false, signal: null };
      },
    };

    await expect(ensureDaemonReady(config, runner)).resolves.toMatchObject({
      gitReady: false,
      gitReadinessReason: "git_unavailable",
    });
    expect(calls).toEqual(["git --version"]);
  });

  it("runAssignedSession completes", async () => {
    const runner: ProcessRunner = {
      async run(opts) {
        if (opts.argv[0] === "git") {
          if (opts.argv.includes("--version")) {
            opts.onChunk({ stream: "stdout", data: "git version 2.36.0\n" });
          }
          return { exitCode: 0, timedOut: false, signal: null };
        }
        opts.onChunk({ stream: "stdout", data: "hi\n" });
        return { exitCode: 0, timedOut: false, signal: null };
      },
    };
    const lines: string[] = [];
    const result = await runAssignedSession(
      config,
      {
        sessionId: "s",
        repositoryId: "repo-1",
        prompt: "hi",
        resolvedArgv: ["echo", "hi"],
        timeout: 10,
        worktreeId: "wt-1",
      },
      (l) => lines.push(l),
      runner,
      runner,
    );
    expect(result.status).toBe("completed");
    expect(lines.length).toBeGreaterThan(0);
  });

  it("refuses an assignment when Git is unavailable", async () => {
    const unavailable: ProcessRunner = {
      async run() {
        return { exitCode: 1, timedOut: false, signal: null };
      },
    };
    await expect(
      runAssignedSession(
        config,
        {
          sessionId: "unready",
          repositoryId: "repo-1",
          prompt: "hi",
          resolvedArgv: ["echo", "hi"],
          timeout: 10,
          worktreeId: "wt-1",
        },
        () => undefined,
        unavailable,
        unavailable,
      ),
    ).rejects.toThrow("Git 2.36 or newer");
  });

  it("uses the command runner only for the assigned CLI", async () => {
    const systemCalls: string[][] = [];
    const commandCalls: string[][] = [];
    const systemRunner: ProcessRunner = {
      async run(options) {
        systemCalls.push(options.argv);
        if (options.argv.includes("--version")) {
          options.onChunk({ stream: "stdout", data: "git version 2.36.0\n" });
        }
        return { exitCode: 0, timedOut: false, signal: null };
      },
    };
    const commandRunner: ProcessRunner = {
      async run(options) {
        commandCalls.push(options.argv);
        return { exitCode: 0, timedOut: false, signal: null };
      },
    };

    await runAssignedSession(
      config,
      {
        sessionId: "pty",
        repositoryId: "repo-1",
        prompt: "literal",
        resolvedArgv: ["tool", "literal"],
        timeout: 10,
        worktreeId: "wt-1",
      },
      () => undefined,
      systemRunner,
      commandRunner,
    );

    expect(systemCalls.every((argv) => argv[0] === "git")).toBe(true);
    expect(commandCalls).toEqual([["tool", "literal"]]);
  });
});
