import { describe, expect, it } from "vitest";

import type { AgentConfig } from "./config.ts";
import { parseAgentConfig } from "./config.ts";
import type { ProcessRunner } from "./executor.ts";
import type { GitClient } from "./git.ts";
import { SessionRunner } from "./session-runner.ts";
import { baseAssign, setup } from "./session-runner-test-helpers.ts";
import { WorktreeManager } from "./worktree-manager.ts";

describe("SessionRunner process and profile failures", () => {
  it("fails when worktreeId is null", async () => {
    const { sessionRunner } = setup({
      async run() {
        return { exitCode: 0, timedOut: false, signal: null };
      },
    });
    const result = await sessionRunner.run(baseAssign({ worktreeId: null }));
    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("setup_failed");
  });

  it("fails non-zero process exit", async () => {
    const runner: ProcessRunner = {
      async run() {
        return { exitCode: 7, timedOut: false, signal: null };
      },
    };
    const { sessionRunner } = setup(runner);
    const result = await sessionRunner.run(baseAssign());
    expect(result.status).toBe("failed");
    expect(result.exitCode).toBe(7);
  });

  it("fails setup script non-zero without changing hook failure status", async () => {
    const config = parseAgentConfig({
      agentId: "a1",
      commandProfiles: {
        "echo-prompt": { argv: ["echo"], appendPrompt: true },
      },
      repositories: [
        {
          id: "repo-1",
          path: "/repo",
          defaultBranch: "main",
          setupScript: "false",
          terminalHookScript: "/hook.sh",
          worktrees: [{ id: "wt-1", name: "wt-1", path: "/repo/wt-1", labels: [] }],
        },
      ],
    });
    const git: GitClient = {
      ensureRepo: async () => undefined,
      ensureWorktree: async () => undefined,
      checkoutRef: async () => undefined,
      revParse: async () => "x",
    };
    const worktrees = new WorktreeManager(config, git);
    const hooks: string[] = [];
    const sessionRunner = new SessionRunner({
      config,
      worktrees,
      processRunner: {
        async run(opts) {
          if (opts.argv[1] === "-c") {
            opts.onChunk({ stream: "stderr", data: "setup no\n" });
            return { exitCode: 1, timedOut: false, signal: null };
          }
          if (opts.argv[1] === "/hook.sh") {
            hooks.push(opts.env?.HARNESS_STATUS ?? "");
            throw new Error("hook boom");
          }
          return { exitCode: 0, timedOut: false, signal: null };
        },
      },
    });
    const result = await sessionRunner.run(baseAssign());
    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("setup_failed");
    expect(hooks).toEqual(["failed"]);
    expect(result.logs.some((l) => l.content.includes("setup no"))).toBe(true);
  });

  it("maps Error and non-Error throws from profile resolve", async () => {
    const config = parseAgentConfig({
      agentId: "a1",
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
    const worktrees = new WorktreeManager(config, {
      ensureRepo: async () => undefined,
      ensureWorktree: async () => undefined,
      checkoutRef: async () => undefined,
      revParse: async () => "x",
    });
    const asError = new SessionRunner({
      config: {
        ...config,
        commandProfiles: new Proxy(
          {},
          {
            get() {
              throw new Error("profile boom");
            },
          },
        ) as AgentConfig["commandProfiles"],
      },
      worktrees,
      processRunner: {
        async run() {
          return { exitCode: 0, timedOut: false, signal: null };
        },
      },
    });
    expect((await asError.run(baseAssign())).errorMessage).toBe("profile boom");

    const asString = new SessionRunner({
      config: {
        ...config,
        commandProfiles: new Proxy(
          {},
          {
            get() {
              throw "string-throw";
            },
          },
        ) as AgentConfig["commandProfiles"],
      },
      worktrees,
      processRunner: {
        async run() {
          return { exitCode: 0, timedOut: false, signal: null };
        },
      },
    });
    expect((await asString.run(baseAssign())).errorMessage).toBe("string-throw");
  });
});
