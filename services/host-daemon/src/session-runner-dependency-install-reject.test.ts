import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseDaemonConfig } from "./config.ts";
import type { ProcessRunner } from "./executor.ts";
import type { GitClient } from "./git.ts";
import { SessionRunner } from "./session-runner.ts";
import { baseAssign } from "./session-runner-test-helpers.ts";
import { WorktreeManager } from "./worktree-manager.ts";

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

describe("SessionRunner dependency install process-runner rejection", () => {
  it("fails structurally and releases the worktree claim when the install call rejects", async () => {
    const cwd = pnpmWorkspaceDir("auto-harness-install-reject-");
    const config = parseDaemonConfig({
      hostId: "a1",
      repositories: [
        {
          id: "repo-1",
          path: cwd,
          defaultBranch: "main",
          worktrees: [{ id: "wt-1", name: "wt-1", path: cwd, labels: [] }],
        },
      ],
    });
    const worktrees = new WorktreeManager(config, noopGit);
    const runner: ProcessRunner = {
      async run(opts) {
        if (opts.argv[0] === INSTALL_BIN) throw new Error("spawn pnpm ENOENT");
        return { exitCode: 0, timedOut: false, signal: null };
      },
    };
    const result = await new SessionRunner({ worktrees, processRunner: runner }).run(baseAssign());
    expect(result).toMatchObject({ status: "failed", errorCode: "setup_failed" });
    expect(result.errorMessage).toContain("spawn pnpm ENOENT");
    await expect(worktrees.claim("repo-1", "wt-1")).resolves.toBeDefined();
  });
});
