import { describe, expect, it, vi } from "vitest";

import type { SessionAssign } from "@auto-harness/shared";

import { parseAgentConfig } from "./config.js";
import type { ProcessRunner } from "./executor.js";
import type { GitClient } from "./git.js";
import { SessionRunner } from "./session-runner.js";
import { WorktreeManager } from "./worktree-manager.js";

function baseAssign(over: Partial<SessionAssign> = {}): SessionAssign {
  return {
    sessionId: "sess-1",
    repositoryId: "repo-1",
    prompt: "hello",
    commandProfile: "echo-prompt",
    timeout: 30,
    worktreeId: "wt-1",
    ...over,
  };
}

function setup(runner: ProcessRunner) {
  const config = parseAgentConfig({
    agentId: "a1",
    commandProfiles: {
      "echo-prompt": { argv: ["echo"], appendPrompt: true },
      "usage-cmd": { argv: ["usage"], appendPrompt: false },
    },
    repositories: [
      {
        id: "repo-1",
        path: "/repo",
        defaultBranch: "main",
        terminalHookScript: "/hook.sh",
        worktrees: [{ id: "wt-1", path: "/repo/wt-1", labels: ["codex"] }],
      },
    ],
  });
  const git: GitClient = {
    ensureRepo: async () => undefined,
    ensureWorktree: async () => undefined,
    checkoutRef: async () => undefined,
    revParse: async () => "deadbeef",
  };
  const worktrees = new WorktreeManager(config, git);
  const hooks: string[] = [];
  const wrapped: ProcessRunner = {
    async run(opts) {
      if (opts.argv[0] === "/bin/sh" && opts.argv[1] === "/hook.sh") {
        hooks.push(opts.env?.HARNESS_STATUS ?? "");
        return { exitCode: 1, timedOut: false, signal: null };
      }
      return runner.run(opts);
    },
  };
  return {
    hooks,
    sessionRunner: new SessionRunner({
      config,
      worktrees,
      processRunner: wrapped,
      now: () => "2026-08-01T00:00:00.000Z",
    }),
  };
}

describe("SessionRunner", () => {
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

  it("checks out provided ref", async () => {
    const checkouts: string[] = [];
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
          worktrees: [{ id: "wt-1", path: "/repo/wt-1", labels: [] }],
        },
      ],
    });
    const git: GitClient = {
      ensureRepo: async () => undefined,
      ensureWorktree: async () => undefined,
      checkoutRef: async ({ ref }) => {
        checkouts.push(ref);
      },
      revParse: async () => "x",
    };
    const worktrees = new WorktreeManager(config, git);
    const sessionRunner = new SessionRunner({
      config,
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

  it("rejects unknown command profiles without spawning", async () => {
    const spawn = vi.fn();
    const runner: ProcessRunner = {
      async run(opts) {
        spawn(opts.argv);
        return { exitCode: 0, timedOut: false, signal: null };
      },
    };
    const { sessionRunner } = setup(runner);
    const result = await sessionRunner.run(baseAssign({ commandProfile: "nope" }));
    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("unknown_command_profile");
    expect(spawn).not.toHaveBeenCalledWith(expect.arrayContaining(["nope"]));
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
    const result = await sessionRunner.run(baseAssign({ commandProfile: "usage-cmd" }));
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
          setupScript: "should-not-run",
          worktrees: [{ id: "wt-1", path: "/repo/wt-1", labels: [] }],
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
    const sessionRunner = new SessionRunner({
      config,
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

  it("fails claim for unknown worktree", async () => {
    const { sessionRunner } = setup({
      async run() {
        return { exitCode: 0, timedOut: false, signal: null };
      },
    });
    const result = await sessionRunner.run(baseAssign({ worktreeId: "missing" }));
    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("setup_failed");
  });

  it("stringifies non-Error claim failures", async () => {
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
          worktrees: [{ id: "wt-1", path: "/repo/wt-1", labels: [] }],
        },
      ],
    });
    const worktrees = {
      claim: () => {
        throw "claim-nope";
      },
      release: () => undefined,
      prepareCheckout: async () => undefined,
      ensureAll: async () => undefined,
      isBusy: () => false,
    } as unknown as WorktreeManager;
    const sessionRunner = new SessionRunner({
      config,
      worktrees,
      processRunner: {
        async run() {
          return { exitCode: 0, timedOut: false, signal: null };
        },
      },
    });
    const result = await sessionRunner.run(baseAssign());
    expect(result.errorMessage).toBe("claim-nope");
  });

  it("fails checkout errors as setup_failed", async () => {
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
          worktrees: [{ id: "wt-1", path: "/repo/wt-1", labels: [] }],
        },
      ],
    });
    const git: GitClient = {
      ensureRepo: async () => undefined,
      ensureWorktree: async () => undefined,
      checkoutRef: async () => {
        throw new Error("bad ref");
      },
      revParse: async () => "x",
    };
    const worktrees = new WorktreeManager(config, git);
    const sessionRunner = new SessionRunner({
      config,
      worktrees,
      processRunner: {
        async run() {
          return { exitCode: 0, timedOut: false, signal: null };
        },
      },
    });
    const result = await sessionRunner.run(baseAssign({ ref: "missing" }));
    expect(result.errorCode).toBe("setup_failed");
    expect(result.errorMessage).toContain("bad ref");

    const worktrees2 = new WorktreeManager(config, {
      ensureRepo: async () => undefined,
      ensureWorktree: async () => undefined,
      checkoutRef: async () => {
        throw "co-nope";
      },
      revParse: async () => "x",
    });
    const runner2 = new SessionRunner({
      config,
      worktrees: worktrees2,
      processRunner: {
        async run() {
          return { exitCode: 0, timedOut: false, signal: null };
        },
      },
    });
    expect((await runner2.run(baseAssign())).errorMessage).toBe("co-nope");
  });

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
          worktrees: [{ id: "wt-1", path: "/repo/wt-1", labels: [] }],
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
          worktrees: [{ id: "wt-1", path: "/repo/wt-1", labels: [] }],
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

import type { AgentConfig } from "./config.js";
