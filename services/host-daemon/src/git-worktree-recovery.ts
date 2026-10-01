import { lstat, readFile, readdir, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import type { ProcessRunner } from "./executor.ts";
import { runGit } from "./git-commands.ts";
import { canonicalPath, listedWorktreePaths } from "./git-worktree-paths.ts";

/**
 * Checking out a large repository legitimately takes longer than the generic 120s git bound,
 * but it stays bounded: a killed add is cleaned up and retried with backoff.
 */
export const WORKTREE_ADD_TIMEOUT_MS = 10 * 60_000;

function within(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  const escapes = rel === ".." || rel.startsWith(`..${sep}`);
  return rel !== "" && !escapes && !isAbsolute(rel);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    // Only a definite absence counts; EACCES/ELOOP/EIO must not be read as "gitdir is gone".
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
}

/**
 * Whether a directory at an unlisted worktree path is provably an abandoned linked-worktree
 * checkout: empty, or carrying a `.git` file whose gitdir no longer exists. A `.git` directory
 * (standalone clone), a gitfile that still resolves, or unrelated content is never ours.
 */
async function isAbandonedCheckout(path: string): Promise<boolean> {
  const marker = resolve(path, ".git");
  if (!(await pathExists(marker))) return (await readdir(path)).length === 0;
  if (!(await lstat(marker)).isFile()) return false;
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(await readFile(marker, "utf8"));
  if (!match?.[1]) return false;
  return !(await pathExists(resolve(path, match[1])));
}

async function repositoryGitDirs(
  runner: ProcessRunner,
  repoPath: string,
  repo: string,
): Promise<string[]> {
  const dirs = [resolve(repo, ".git")];
  for (const flag of ["--absolute-git-dir", "--git-common-dir"]) {
    const result = await runGit(runner, repoPath, ["rev-parse", flag]);
    if (result.exitCode !== 0 || !result.stdout.trim()) {
      throw new Error(`Refusing to recover a worktree: could not resolve ${flag} for ${repo}`);
    }
    dirs.push(await canonicalPath(resolve(repo, result.stdout.trim())));
  }
  return dirs;
}

/**
 * Clear an unregistered directory left at a managed worktree path by an interrupted
 * `git worktree add`. Refuses (throws) for anything it cannot prove is an abandoned linked
 * checkout, and never touches the repository or paths enclosing it. An empty directory is
 * removed; a non-empty one may still hold user changes, so it is moved aside (never deleted)
 * for manual recovery. The caller has already established that git does not list the path.
 */
export async function removeAbandonedWorktreeDir(
  runner: ProcessRunner,
  repoPath: string,
  worktreePath: string,
): Promise<void> {
  const repo = await canonicalPath(repoPath);
  const target = await canonicalPath(worktreePath);
  // The repository may itself be a linked worktree or keep a separate git dir, so `.git` can be
  // a mere gitfile; protect the real administrative and common directories too.
  const protectedDirs = await repositoryGitDirs(runner, repoPath, repo);
  if (
    target === repo ||
    within(target, repo) ||
    protectedDirs.some((dir) => target === dir || within(dir, target) || within(target, dir)) ||
    dirname(target) === target
  ) {
    throw new Error(`Refusing to remove ${target}: it overlaps the repository`);
  }
  if (!(await isAbandonedCheckout(target))) {
    throw new Error(
      `Worktree path ${target} exists but is not a registered worktree and is not an abandoned checkout; remove it manually`,
    );
  }
  await runGit(runner, repoPath, ["worktree", "prune"]);
  if ((await readdir(target)).length === 0) await rm(target, { recursive: true, force: true });
  else await rename(target, `${target}.abandoned-${Date.now()}`);
}

/**
 * Undo a failed or aborted `git worktree add` that started on a path that did not exist.
 * Returns false when cleanup could not complete, so the caller keeps the target quarantined.
 */
export async function cleanupFailedWorktreeAdd(
  runner: ProcessRunner,
  repoPath: string,
  worktreePath: string,
): Promise<boolean> {
  try {
    const list = await runGit(runner, repoPath, ["worktree", "list", "--porcelain"]);
    if (list.exitCode !== 0) return false;
    if ((await listedWorktreePaths(list.stdout, repoPath)).has(await canonicalPath(worktreePath))) {
      const removed = await runGit(runner, repoPath, [
        "worktree",
        "remove",
        "--force",
        worktreePath,
      ]);
      if (removed.exitCode !== 0) return false;
    }
    const pruned = await runGit(runner, repoPath, ["worktree", "prune"]);
    if (pruned.exitCode !== 0) return false;
    // The path did not exist before this attempt, so anything left is the partial checkout.
    await rm(worktreePath, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

export { pathExists };
