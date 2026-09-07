import { lstat, realpath, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

import type { ProcessRunner } from "./executor.ts";
import { runGit } from "./git-commands.ts";

const STALE_INDEX_LOCK_AGE_MS = 5 * 60 * 1_000;

type GitResult = Awaited<ReturnType<typeof runGit>>;

async function canonicalPath(path: string): Promise<string> {
  const absolutePath = resolve(path);
  try {
    return await realpath(absolutePath);
  } catch {
    return absolutePath;
  }
}

export async function checkoutDetached(
  runner: ProcessRunner,
  cwd: string,
  sha: string,
  signal?: AbortSignal,
): Promise<GitResult> {
  let checkout = await runGit(
    runner,
    cwd,
    ["switch", "--discard-changes", "--detach", sha],
    signal,
  );
  if (checkout.exitCode !== 0) {
    checkout = await runGit(runner, cwd, ["checkout", "--force", "--detach", sha], signal);
  }
  return checkout;
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function isLinkedWorktreeGitDir(commonDir: string, gitDir: string): boolean {
  const pathFromCommonDir = relative(commonDir, gitDir);
  const parts = pathFromCommonDir.split(sep);
  return (
    parts.length === 2 &&
    parts[0] === "worktrees" &&
    parts[1] !== undefined &&
    parts[1].length > 0 &&
    !isAbsolute(pathFromCommonDir)
  );
}

export async function removeStaleIndexLock(
  runner: ProcessRunner,
  cwd: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const commonDirResult = await runGit(
    runner,
    cwd,
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    signal,
  );
  const gitDirResult = await runGit(
    runner,
    cwd,
    ["rev-parse", "--path-format=absolute", "--git-dir"],
    signal,
  );
  const lockPathResult = await runGit(
    runner,
    cwd,
    ["rev-parse", "--path-format=absolute", "--git-path", "index.lock"],
    signal,
  );
  if (
    commonDirResult.exitCode !== 0 ||
    gitDirResult.exitCode !== 0 ||
    lockPathResult.exitCode !== 0
  ) {
    return false;
  }

  const reportedCommonDir = commonDirResult.stdout.trim();
  const reportedGitDir = gitDirResult.stdout.trim();
  const reportedLockPath = lockPathResult.stdout.trim();
  if (
    !isAbsolute(reportedCommonDir) ||
    !isAbsolute(reportedGitDir) ||
    !isAbsolute(reportedLockPath)
  ) {
    return false;
  }

  const commonDir = await canonicalPath(reportedCommonDir);
  const gitDir = await canonicalPath(reportedGitDir);
  const lockPath = resolve(
    await canonicalPath(dirname(reportedLockPath)),
    basename(reportedLockPath),
  );
  if (
    !isLinkedWorktreeGitDir(commonDir, gitDir) ||
    basename(lockPath) !== "index.lock" ||
    dirname(lockPath) !== gitDir ||
    lockPath !== resolve(gitDir, "index.lock")
  ) {
    return false;
  }

  let initial;
  try {
    initial = await lstat(lockPath);
  } catch (error) {
    return isMissingFile(error);
  }
  if (
    !initial.isFile() ||
    initial.size !== 0 ||
    Date.now() - initial.mtimeMs < STALE_INDEX_LOCK_AGE_MS
  ) {
    return false;
  }
  if (signal?.aborted) return false;

  try {
    await unlink(lockPath);
    return true;
  } catch (error) {
    return isMissingFile(error);
  }
}
