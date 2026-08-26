import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseDaemonConfig } from "./config.ts";
import type { ProcessRunner } from "./executor.ts";
import type { GitClient } from "./git.ts";
import { SessionRunner } from "./session-runner.ts";
import { baseAssign } from "./session-runner-test-helpers.ts";
import { WorktreeManager } from "./worktree-manager.ts";

/** Matches installWorkspaceDependencies' platform-conditional argv[0]. */
const INSTALL_BIN = process.platform === "win32" ? "cmd.exe" : "pnpm";

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

describe("SessionRunner dependency install ordering around setup scripts", () => {
  it("runs the install after a configured setup script completes", async () => {
    const cwd = pnpmWorkspaceDir("auto-harness-install-after-setup-");
    const { worktrees } = runnerFor(cwd, { setupScript: "custom-setup" });
    const order: string[] = [];
    const runner: ProcessRunner = {
      async run(opts) {
        if (opts.argv[1] === "-c") {
          order.push("setup");
          return { exitCode: 0, timedOut: false, signal: null, environment: opts.env ?? {} };
        }
        if (opts.argv[0] === INSTALL_BIN) {
          order.push("install");
          return { exitCode: 0, timedOut: false, signal: null };
        }
        order.push("command");
        return { exitCode: 0, timedOut: false, signal: null };
      },
    };
    const result = await new SessionRunner({ worktrees, processRunner: runner }).run(baseAssign());
    expect(result.status).toBe("completed");
    expect(order).toEqual(["setup", "install", "command"]);
  });

  it("skips install when a setup script removes the lockfile the pre-setup snapshot saw", async () => {
    const cwd = pnpmWorkspaceDir("auto-harness-install-setup-removes-lockfile-");
    const { worktrees } = runnerFor(cwd, { setupScript: "custom-setup" });
    const calls: string[][] = [];
    const runner: ProcessRunner = {
      async run(opts) {
        calls.push(opts.argv);
        if (opts.argv[1] === "-c") {
          rmSync(join(cwd, "pnpm-lock.yaml"));
          return { exitCode: 0, timedOut: false, signal: null, environment: opts.env ?? {} };
        }
        return { exitCode: 0, timedOut: false, signal: null };
      },
    };
    const result = await new SessionRunner({ worktrees, processRunner: runner }).run(baseAssign());
    expect(result.status).toBe("completed");
    expect(calls.some((argv) => argv[0] === INSTALL_BIN)).toBe(false);
  });

  it("runs install when a setup script adds a lockfile the pre-setup snapshot did not see", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "auto-harness-install-setup-adds-lockfile-"));
    mkdirSync(cwd, { recursive: true });
    const { worktrees } = runnerFor(cwd, { setupScript: "custom-setup" });
    const calls: string[][] = [];
    const runner: ProcessRunner = {
      async run(opts) {
        calls.push(opts.argv);
        if (opts.argv[1] === "-c") {
          writeFileSync(join(cwd, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
          return { exitCode: 0, timedOut: false, signal: null, environment: opts.env ?? {} };
        }
        return { exitCode: 0, timedOut: false, signal: null };
      },
    };
    const result = await new SessionRunner({ worktrees, processRunner: runner }).run(baseAssign());
    expect(result.status).toBe("completed");
    expect(calls.some((argv) => argv[0] === INSTALL_BIN)).toBe(true);
  });

  it("forces the post-setup install even when node_modules already carries a matching import-method marker (#350 hardening)", async () => {
    const cwd = pnpmWorkspaceDir("auto-harness-install-setup-marker-invalidated-");
    mkdirSync(join(cwd, "node_modules"), { recursive: true });
    writeFileSync(join(cwd, "node_modules", ".auto-harness-package-import-method"), "copy");
    const { worktrees } = runnerFor(cwd, { setupScript: "custom-setup" });
    let installArgv: string[] | undefined;
    const runner: ProcessRunner = {
      async run(opts) {
        if (opts.argv[1] === "-c") {
          return { exitCode: 0, timedOut: false, signal: null, environment: opts.env ?? {} };
        }
        if (opts.argv[0] === INSTALL_BIN) installArgv = opts.argv;
        return { exitCode: 0, timedOut: false, signal: null };
      },
    };
    const result = await new SessionRunner({ worktrees, processRunner: runner }).run(baseAssign());
    expect(result.status).toBe("completed");
    // A setup script could have run its own unpinned `pnpm install` and left
    // this pre-existing marker's "copy" claim stale; the install must not
    // trust it just because it still matches.
    expect(installArgv).toContain("--force");
  });
});
