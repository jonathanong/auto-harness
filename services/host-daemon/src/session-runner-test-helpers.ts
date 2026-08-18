import type { SessionAssign } from "@auto-harness/shared";

import { parseDaemonConfig } from "./config.ts";
import type { ProcessRunner } from "./executor.ts";
import type { GitClient } from "./git.ts";
import { SessionRunner } from "./session-runner.ts";
import { WorktreeManager } from "./worktree-manager.ts";

export function baseAssign(over: Partial<SessionAssign> = {}): SessionAssign {
  return {
    sessionId: "sess-1",
    attemptId: "attempt-1",
    repositoryId: "repo-1",
    prompt: "hello",
    resolvedArgv: ["echo", "hello"],
    timeout: 30,
    worktreeId: "wt-1",
    ...over,
  };
}

export function setup(runner: ProcessRunner) {
  const config = parseDaemonConfig({
    hostId: "a1",
    repositories: [
      {
        id: "repo-1",
        path: "/repo",
        defaultBranch: "main",
        terminalHookScript: "/hook.sh",
        worktrees: [{ id: "wt-1", name: "wt-1", path: "/repo/wt-1", labels: ["codex"] }],
      },
    ],
  });
  const git: GitClient = {
    ensureRepo: async () => undefined,
    ensureWorktree: async () => undefined,
    checkoutRef: async () => undefined,
    prepareMainCheckout: async () => undefined,
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
      worktrees,
      processRunner: wrapped,
      now: () => "2026-08-01T00:00:00.000Z",
    }),
  };
}
