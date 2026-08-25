import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseDaemonConfig } from "./config.ts";
import type { ProcessRunner } from "./executor.ts";
import type { GitClient } from "./git.ts";
import { SessionRunner } from "./session-runner.ts";
import { baseAssign } from "./session-runner-test-helpers.ts";
import { WorktreeManager } from "./worktree-manager.ts";

/** Matches installWorkspaceDependencies' platform-conditional argv. */
const INSTALL_ARGV =
  process.platform === "win32"
    ? ["cmd.exe", "/d", "/s", "/c", "pnpm", "install", "--frozen-lockfile"]
    : ["pnpm", "install", "--frozen-lockfile"];

const noopGit: GitClient = {
  ensureRepo: async () => undefined,
  ensureWorktree: async () => undefined,
  checkoutRef: async () => undefined,
  prepareMainCheckout: async () => undefined,
  revParse: async () => "deadbeef",
};

function pnpmWorkspaceDir(prefix: string): string {
  const cwd = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(join(cwd, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  return cwd;
}

function runnerFor(worktreePath: string, repositoryOverrides: Record<string, unknown> = {}) {
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

describe("SessionRunner dependency install", () => {
  it("installs workspace dependencies when the worktree has a pnpm lockfile", async () => {
    const cwd = pnpmWorkspaceDir("auto-harness-install-run-");
    const { worktrees } = runnerFor(cwd);
    const calls: string[][] = [];
    const runner: ProcessRunner = {
      async run(opts) {
        calls.push(opts.argv);
        return { exitCode: 0, timedOut: false, signal: null };
      },
    };
    const result = await new SessionRunner({ worktrees, processRunner: runner }).run(baseAssign());
    expect(result.status).toBe("completed");
    expect(calls).toEqual([INSTALL_ARGV, ["echo", "hello"]]);
    const system = result.logs
      .filter((chunk) => chunk.stream === "system")
      .map((chunk) => chunk.content);
    expect(system).toEqual(
      expect.arrayContaining([
        "Installing workspace dependencies...",
        "Workspace dependencies installed.",
      ]),
    );
    expect(system).not.toContain("Running setup script...");
  });

  it("skips install cleanly when the worktree has no pnpm lockfile", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "auto-harness-no-lockfile-"));
    mkdirSync(cwd, { recursive: true });
    const { worktrees } = runnerFor(cwd);
    const calls: string[][] = [];
    const runner: ProcessRunner = {
      async run(opts) {
        calls.push(opts.argv);
        return { exitCode: 0, timedOut: false, signal: null };
      },
    };
    const result = await new SessionRunner({ worktrees, processRunner: runner }).run(baseAssign());
    expect(result.status).toBe("completed");
    expect(calls).toEqual([["echo", "hello"]]);
  });

  it("skips install on resume even when a lockfile is present", async () => {
    const cwd = pnpmWorkspaceDir("auto-harness-install-resume-");
    const { worktrees } = runnerFor(cwd);
    const calls: string[][] = [];
    const runner: ProcessRunner = {
      async run(opts) {
        calls.push(opts.argv);
        return { exitCode: 0, timedOut: false, signal: null };
      },
    };
    const result = await new SessionRunner({ worktrees, processRunner: runner }).run(
      baseAssign({ resume: true, resolvedArgv: ["tool", "resume", "ref"] }),
    );
    expect(result.status).toBe("completed");
    expect(calls).toEqual([["tool", "resume", "ref"]]);
  });

  it("fails the session structurally when the install exits non-zero", async () => {
    const cwd = pnpmWorkspaceDir("auto-harness-install-fail-");
    const { worktrees } = runnerFor(cwd);
    const spawn = { called: false };
    const runner: ProcessRunner = {
      async run(opts) {
        if (opts.argv[0] === INSTALL_ARGV[0]) {
          opts.onChunk({ stream: "stderr", data: "ERR_PNPM_OUTDATED_LOCKFILE\n" });
          return { exitCode: 1, timedOut: false, signal: null };
        }
        spawn.called = true;
        return { exitCode: 0, timedOut: false, signal: null };
      },
    };
    const result = await new SessionRunner({ worktrees, processRunner: runner }).run(baseAssign());
    expect(result).toMatchObject({
      status: "failed",
      errorCode: "setup_failed",
      errorMessage: "workspace dependency install failed",
      exitCode: 1,
    });
    expect(spawn.called).toBe(false);
  });

  it("marks the session timed_out when the install exceeds its deadline", async () => {
    const cwd = pnpmWorkspaceDir("auto-harness-install-timeout-");
    const { worktrees } = runnerFor(cwd);
    const runner: ProcessRunner = {
      async run(opts) {
        if (opts.argv[0] === INSTALL_ARGV[0]) {
          return { exitCode: null, timedOut: true, signal: "SIGTERM" };
        }
        return { exitCode: 0, timedOut: false, signal: null };
      },
    };
    const result = await new SessionRunner({ worktrees, processRunner: runner }).run(baseAssign());
    expect(result.status).toBe("timed_out");
  });

  it("marks the session cancelled when the install is aborted", async () => {
    const cwd = pnpmWorkspaceDir("auto-harness-install-cancel-");
    const { worktrees } = runnerFor(cwd);
    const controller = new AbortController();
    const runner: ProcessRunner = {
      async run(opts) {
        if (opts.argv[0] === INSTALL_ARGV[0]) {
          controller.abort();
          return { exitCode: null, timedOut: false, cancelled: true, signal: null };
        }
        return { exitCode: 0, timedOut: false, signal: null };
      },
    };
    const result = await new SessionRunner({ worktrees, processRunner: runner }).run(baseAssign(), {
      signal: controller.signal,
    });
    expect(result.status).toBe("cancelled");
  });

  it("fails setup structurally when inventory changes before the install step", async () => {
    const cwd = pnpmWorkspaceDir("auto-harness-install-revalidate-");
    const { config, worktrees } = runnerFor(cwd, { setupScript: "custom-setup" });
    const order: string[] = [];
    const runner: ProcessRunner = {
      async run(opts) {
        if (opts.argv[1] === "-c") {
          order.push("setup");
          config.repositories = [{ ...config.repositories[0]!, setupScript: "replacement-setup" }];
          worktrees.noteInventoryChange();
          return { exitCode: 0, timedOut: false, signal: null, environment: opts.env ?? {} };
        }
        order.push("unexpected");
        return { exitCode: 0, timedOut: false, signal: null };
      },
    };
    const result = await new SessionRunner({ worktrees, processRunner: runner }).run(baseAssign());
    expect(result).toMatchObject({
      status: "failed",
      errorCode: "setup_failed",
      errorMessage: "host inventory changed after this checkout was claimed",
    });
    expect(order).toEqual(["setup"]);
  });
});
