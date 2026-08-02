import type { ProcessRunner } from "./executor.js";

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
      const add = await runGit(runner, repoPath, [
        "worktree",
        "add",
        "-B",
        branch,
        worktreePath,
        branch,
      ]);
      if (add.exitCode !== 0) {
        // try from HEAD if branch missing
        const addHead = await runGit(runner, repoPath, [
          "worktree",
          "add",
          "--detach",
          worktreePath,
          "HEAD",
        ]);
        if (addHead.exitCode !== 0) {
          throw new Error(
            `Failed to create worktree at ${worktreePath}: ${add.stderr || addHead.stderr}`,
          );
        }
      }
    },

    async checkoutRef({ cwd, ref }) {
      const fetch = await runGit(runner, cwd, ["fetch", "--all", "--tags"]);
      // fetch may fail offline; still try checkout
      void fetch;
      const co = await runGit(runner, cwd, ["checkout", "--force", ref]);
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
