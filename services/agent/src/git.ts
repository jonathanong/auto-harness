import type { ProcessRunner } from "./executor.ts";

export type GitClient = {
  ensureRepo(path: string): Promise<void>;
  ensureWorktree(opts: { repoPath: string; worktreePath: string; branch: string }): Promise<void>;
  checkoutRef(opts: { cwd: string; ref: string }): Promise<void>;
  revParse(cwd: string, rev: string): Promise<string>;
};

async function runGit(
  runner: ProcessRunner,
  cwd: string,
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const result = await runner.run({
    argv: ["git", ...args],
    cwd,
    timeoutMs: 120_000,
    onChunk: (c) => {
      if (c.stream === "stdout") {
        stdout += c.data;
      } else {
        stderr += c.data;
      }
    },
  });
  return {
    exitCode: result.exitCode ?? 1,
    stdout,
    stderr,
  };
}

export function createGitClient(runner: ProcessRunner): GitClient {
  return {
    async ensureRepo(path: string) {
      const probe = await runGit(runner, path, ["rev-parse", "--is-inside-work-tree"]);
      if (probe.exitCode !== 0) {
        throw new Error(`Not a git repository: ${path}`);
      }
    },

    async ensureWorktree({ repoPath, worktreePath, branch }) {
      await this.ensureRepo(repoPath);
      const list = await runGit(runner, repoPath, ["worktree", "list", "--porcelain"]);
      if (list.stdout.includes(worktreePath)) {
        return;
      }
      // Always add detached so the branch can remain checked out in the main tree.
      let tip = await runGit(runner, repoPath, ["rev-parse", "--verify", branch]);
      if (tip.exitCode !== 0) {
        tip = await runGit(runner, repoPath, ["rev-parse", "--verify", "HEAD"]);
      }
      if (tip.exitCode !== 0) {
        throw new Error(`Failed to resolve tip for worktree ${worktreePath}: ${tip.stderr}`);
      }
      const sha = tip.stdout.trim();
      const add = await runGit(runner, repoPath, [
        "worktree",
        "add",
        "--detach",
        worktreePath,
        sha,
      ]);
      if (add.exitCode !== 0) {
        throw new Error(`Failed to create worktree at ${worktreePath}: ${add.stderr}`);
      }
    },

    async checkoutRef({ cwd, ref }) {
      // Prefer detached checkout so a branch already used by the main repo
      // (e.g. ref "main" while primary tree is on main) still works.
      let resolved = await runGit(runner, cwd, ["rev-parse", "--verify", ref]);
      if (resolved.exitCode !== 0) {
        await runGit(runner, cwd, ["fetch", "--all", "--tags"]);
        resolved = await runGit(runner, cwd, ["rev-parse", "--verify", ref]);
      }
      if (resolved.exitCode !== 0) {
        throw new Error(`Failed to resolve ref ${ref}: ${resolved.stderr}`);
      }
      const sha = resolved.stdout.trim();
      let co = await runGit(runner, cwd, ["switch", "--detach", sha]);
      if (co.exitCode !== 0) {
        co = await runGit(runner, cwd, ["checkout", "--detach", sha]);
      }
      if (co.exitCode !== 0) {
        throw new Error(`Failed to checkout ref ${ref}: ${co.stderr}`);
      }
    },

    async revParse(cwd, rev) {
      const result = await runGit(runner, cwd, ["rev-parse", rev]);
      if (result.exitCode !== 0) {
        throw new Error(`git rev-parse ${rev} failed: ${result.stderr}`);
      }
      return result.stdout.trim();
    },
  };
}
