import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SessionAssign } from "@auto-harness/shared";

import { parseDaemonConfig } from "./config.ts";
import type { ProcessRunner } from "./executor.ts";
import type { GitClient } from "./git.ts";
import type { ExecutionProfiles } from "./execution-profiles.ts";
import { resolveTrustedExecutable } from "./resolve-executable.ts";
import { SessionRunner } from "./session-runner.ts";
import { WorktreeManager } from "./worktree-manager.ts";

export const testExecutionProfiles: ExecutionProfiles = {
  maxConcurrentAssignments: 1,
  profiles: new Map([["acct-1", { providerAccountId: "acct-1", home: tmpdir(), env: {} }]]),
};

export const noopGit: GitClient = {
  ensureRepo: async () => undefined,
  ensureWorktree: async () => undefined,
  checkoutRef: async () => undefined,
  prepareMainCheckout: async () => undefined,
  revParse: async () => "deadbeef",
};

export function pnpmWorkspaceDir(prefix: string): string {
  const cwd = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(join(cwd, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  return cwd;
}

export function runnerFor(worktreePath: string, repositoryOverrides: Record<string, unknown> = {}) {
  const config = parseDaemonConfig({
    hostId: "a1",
    repositories: [
      {
        id: "repo-1",
        path: worktreePath,
        defaultBranch: "main",
        worktrees: [{ id: "wt-1", name: "wt-1", path: worktreePath, labels: [] }],
        ...repositoryOverrides,
      },
    ],
  });
  const worktrees = new WorktreeManager(config, noopGit);
  return { config, worktrees };
}

let installBinCache: string | undefined;

/**
 * installWorkspaceDependencies' platform-conditional, now-resolved argv[0].
 * Resolved lazily rather than at module load: this helper module is a widely
 * shared import, and resolveTrustedExecutable throws on a PATH miss — a
 * module-level throw here would fail every file that merely imports this
 * module (e.g. on an unusual PATH/platform), not just the tests exercising
 * install resolution.
 */
export function installBin(): string {
  installBinCache ??= resolveTrustedExecutable(
    process.platform === "win32" ? "cmd.exe" : "pnpm",
    process.env,
    process.platform,
  );
  return installBinCache;
}

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
      const result = await runner.run(opts);
      const isSetup = opts.argv[1] === "-c" && opts.argv[3] === "auto-harness-setup";
      if (isSetup && result.exitCode === 0 && !result.timedOut && !result.cancelled) {
        return { ...result, environment: result.environment ?? opts.env ?? {} };
      }
      return result;
    },
  };
  return {
    hooks,
    sessionRunner: new SessionRunner({
      worktrees,
      processRunner: wrapped,
      executionProfiles: testExecutionProfiles,
      now: () => "2026-08-01T00:00:00.000Z",
    }),
  };
}
