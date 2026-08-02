import { describe, expect, it } from "vitest";

import { parseAgentConfig } from "./config.js";
import type { ProcessRunner } from "./executor.js";
import { ensureAgentReady, runAssignedSession } from "./runtime.js";

const config = parseAgentConfig({
  agentId: "a1",
  commandProfiles: { echo: { argv: ["echo"], appendPrompt: true } },
  repositories: [
    {
      id: "repo-1",
      path: "/repo",
      defaultBranch: "main",
      worktrees: [{ id: "wt-1", path: "/repo/wt-1", labels: [] }],
    },
  ],
});

describe("runtime helpers", () => {
  it("ensureAgentReady uses git client", async () => {
    const calls: string[] = [];
    const runner: ProcessRunner = {
      async run(opts) {
        calls.push(opts.argv.join(" "));
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
    await ensureAgentReady(config, runner);
    expect(calls.some((c) => c.includes("rev-parse"))).toBe(true);
  });

  it("runAssignedSession completes", async () => {
    const runner: ProcessRunner = {
      async run(opts) {
        if (opts.argv[0] === "git") {
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
        commandProfile: "echo",
        timeout: 10,
        worktreeId: "wt-1",
      },
      (l) => lines.push(l),
      runner,
    );
    expect(result.status).toBe("completed");
    expect(lines.length).toBeGreaterThan(0);
  });
});
