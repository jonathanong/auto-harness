import { lstat, readFile, readdir, rm } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

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
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
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

/**
 * Remove an unregistered directory left at a managed worktree path by an interrupted
 * `git worktree add`. Refuses (throws) rather than deleting anything it cannot prove is an
 * abandoned linked checkout, and never touches the repository or paths enclosing it.
 * The caller has already established that git does not list the path.
 */
export async function removeAbandonedWorktreeDir(
  runner: ProcessRunner,
  repoPath: string,
  worktreePath: string,
): Promise<void> {
  const repo = await canonicalPath(repoPath);
  const target = await canonicalPath(worktreePath);
  if (
    target === repo ||
    within(target, repo) ||
    within(resolve(repo, ".git"), target) ||
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
  await rm(target, { recursive: true, force: true });
}

/** Undo a failed or aborted `git worktree add` that started on a path that did not exist. */
export async function cleanupFailedWorktreeAdd(
  runner: ProcessRunner,
  repoPath: string,
  worktreePath: string,
): Promise<void> {
  try {
    const list = await runGit(runner, repoPath, ["worktree", "list", "--porcelain"]);
    if (
      list.exitCode === 0 &&
      (await listedWorktreePaths(list.stdout, repoPath)).has(await canonicalPath(worktreePath))
    ) {
      await runGit(runner, repoPath, ["worktree", "remove", "--force", worktreePath]);
    }
    await runGit(runner, repoPath, ["worktree", "prune"]);
    // The path did not exist before this attempt, so anything left is the partial checkout.
    await rm(worktreePath, { recursive: true, force: true });
  } catch {
    // Best effort: the next attempt re-detects any leftover through removeAbandonedWorktreeDir.
  }
}

export { pathExists };
