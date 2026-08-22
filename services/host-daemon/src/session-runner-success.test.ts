import { describe, expect, it, vi } from "vitest";

import { parseDaemonConfig } from "./config.ts";
import type { ProcessRunner } from "./executor.ts";
import type { GitClient } from "./git.ts";
import { SessionRunner } from "./session-runner.ts";
import { baseAssign, setup } from "./session-runner-test-helpers.ts";
import { WorktreeManager } from "./worktree-manager.ts";

describe("SessionRunner success paths", () => {
  it("completes a successful profile run and still runs hook", async () => {
    const runner: ProcessRunner = {
      async run(opts) {
        expect(opts.argv).toEqual(["echo", "hello"]);
        opts.onChunk({ stream: "stdout", data: "ok\n" });
        return { exitCode: 0, timedOut: false, signal: null };
      },
    };
    const { sessionRunner, hooks } = setup(runner);
    const result = await sessionRunner.run(baseAssign({ ref: "main", metadata: { pr: 9 } }));
    expect(result.status).toBe("completed");
    expect(result.exitCode).toBe(0);
    expect(hooks).toEqual(["completed"]);
    expect(result.logs.some((l) => l.seq === 0)).toBe(true);
  });

  it("captures a configured CLI resume reference without logging the opaque value", async () => {
    const emitted: string[] = [];
    const { sessionRunner } = setup({
      async run(opts) {
        opts.onChunk({ stream: "stdout", data: "resume-ref: native-" });
        opts.onChunk({ stream: "stdout", data: "conversation-1\n" });
        return { exitCode: 0, timedOut: false, signal: null };
      },
    });
    const result = await sessionRunner.run(
      baseAssign({
        resumeRefCapture: { stream: "stdout", linePrefix: "resume-ref: " },
      }),
    );
    for (const chunk of result.logs) {
      emitted.push(chunk.content);
    }
    expect(result).toMatchObject({ status: "completed", cliResumeRef: "native-conversation-1" });
    expect(emitted).toContain("Captured CLI resume reference");
    expect(emitted).toContain("[CLI resume reference redacted]\n");
    expect(emitted.some((line) => line.includes("native-conversation-1"))).toBe(false);
  });

  it("does not copy an opaque native resume reference into system logs", async () => {
    const { sessionRunner } = setup({
      async run(opts) {
        expect(opts.argv).toEqual(["tool", "resume", "opaque-ref"]);
        return { exitCode: 0, timedOut: false, signal: null };
      },
    });
    const result = await sessionRunner.run(
      baseAssign({ resume: true, resolvedArgv: ["tool", "resume", "opaque-ref"] }),
    );
    expect(
      result.logs.some(
        (chunk) => chunk.stream === "system" && chunk.content.includes("opaque-ref"),
      ),
    ).toBe(false);
  });

  it("checks out provided ref", async () => {
    const checkouts: string[] = [];
    const config = parseDaemonConfig({
      hostId: "a1",
      commandProfiles: {
        "echo-prompt": { argv: ["echo"], appendPrompt: true },
      },
      repositories: [
        {
          id: "repo-1",
          path: "/repo",
          defaultBranch: "main",
          worktrees: [{ id: "wt-1", name: "wt-1", path: "/repo/wt-1", labels: [] }],
        },
      ],
    });
    const git: GitClient = {
      ensureRepo: async () => undefined,
      ensureWorktree: async () => undefined,
      checkoutRef: async ({ ref }) => {
        checkouts.push(ref);
      },
      prepareMainCheckout: async () => undefined,
      revParse: async () => "x",
    };
    const worktrees = new WorktreeManager(config, git);
    const sessionRunner = new SessionRunner({
      worktrees,
      processRunner: {
        async run() {
          return { exitCode: 0, timedOut: false, signal: null };
        },
      },
    });
    await sessionRunner.run(baseAssign({ ref: "feature/pr-1" }));
    expect(checkouts).toEqual(["feature/pr-1"]);
  });

  it("rejects an empty resolvedArgv without spawning", async () => {
    const spawn = vi.fn();
    const runner: ProcessRunner = {
      async run(opts) {
        spawn(opts.argv);
        return { exitCode: 0, timedOut: false, signal: null };
      },
    };
    const { sessionRunner } = setup(runner);
    const result = await sessionRunner.run(baseAssign({ resolvedArgv: [] }));
    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("unknown_command_profile");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("marks usage_limit when output matches", async () => {
    const runner: ProcessRunner = {
      async run(opts) {
        opts.onChunk({
          stream: "stderr",
          data: "Error: insufficient_quota for request",
        });
        return { exitCode: 1, timedOut: false, signal: null };
      },
    };
    const { sessionRunner, hooks } = setup(runner);
    const result = await sessionRunner.run(baseAssign({ resolvedArgv: ["usage"] }));
    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("usage_limit");
    expect(hooks).toEqual(["failed"]);
  });

  it("returns timed_out when process times out", async () => {
    const runner: ProcessRunner = {
      async run() {
        return { exitCode: null, timedOut: true, signal: "SIGTERM" };
      },
    };
    const { sessionRunner, hooks } = setup(runner);
    const result = await sessionRunner.run(baseAssign());
    expect(result.status).toBe("timed_out");
    expect(hooks).toEqual(["timed_out"]);
  });

  it("skips setup script on resume", async () => {
    const setupSpy = vi.fn();
    const config = parseDaemonConfig({
      hostId: "a1",
      setupScript: "host-setup-should-not-run",
      commandProfiles: {
        "echo-prompt": { argv: ["echo"], appendPrompt: true },
      },
      repositories: [
        {
          id: "repo-1",
          path: "/repo",
          defaultBranch: "main",
          setupScript: "should-not-run",
          worktrees: [{ id: "wt-1", name: "wt-1", path: "/repo/wt-1", labels: [] }],
        },
      ],
    });
    const git: GitClient = {
      ensureRepo: async () => undefined,
      ensureWorktree: async () => undefined,
      checkoutRef: async () => undefined,
      prepareMainCheckout: async () => undefined,
      revParse: async () => "x",
    };
    const worktrees = new WorktreeManager(config, git);
    const sessionRunner = new SessionRunner({
      worktrees,
      processRunner: {
        async run(opts) {
          if (opts.argv[1] === "-c") {
            setupSpy();
          }
          return { exitCode: 0, timedOut: false, signal: null };
        },
      },
    });
    const result = await sessionRunner.run(baseAssign({ resume: true }));
    expect(result.status).toBe("completed");
    expect(setupSpy).not.toHaveBeenCalled();
  });

  it("uses the remaining session deadline for the primary command after setup", async () => {
    const timeouts: number[] = [];
    const { sessionRunner } = setup({
      async run(options) {
        if (options.argv[1] === "-c") {
          await new Promise<void>((resolve) => setTimeout(resolve, 30));
        } else {
          timeouts.push(options.timeoutMs);
        }
        return { exitCode: 0, timedOut: false, signal: null };
      },
    });
    const result = await sessionRunner.run(baseAssign({ timeout: 1, setupScript: "slow" }));
    expect(result.status).toBe("completed");
    expect(timeouts[0]).toBeGreaterThan(0);
    expect(timeouts[0]).toBeLessThan(1_000);
  });
});
