import { lstat, readFile, realpath, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

import type { ProcessRunner } from "./executor.ts";
import { runGit } from "./git-commands.ts";
import { resetPriorWorktreeState } from "./git-worktree-reset.ts";

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
  if (checkout.exitCode === 0) {
    checkout = await runGit(runner, cwd, ["reset", "--hard", sha], signal);
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

async function configuredCommonDir(repoPath: string): Promise<string | null> {
  try {
    const gitPath = resolve(await canonicalPath(repoPath), ".git");
    if ((await lstat(gitPath)).isDirectory()) return await canonicalPath(gitPath);
    if (!(await lstat(gitPath)).isFile()) return null;
    const pointerMatch = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(await readFile(gitPath, "utf8"));
    if (!pointerMatch?.[1]) return null;
    const gitDir = await canonicalPath(
      isAbsolute(pointerMatch[1]) ? pointerMatch[1] : resolve(dirname(gitPath), pointerMatch[1]),
    );
    if (!(await lstat(gitDir)).isDirectory()) return null;
    try {
      if ((await lstat(resolve(gitDir, "gitdir"))).isFile()) {
        return basename(dirname(gitDir)) === "worktrees" ? dirname(dirname(gitDir)) : null;
      }
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
    return gitDir;
  } catch {
    return null;
  }
}

async function claimedLinkedWorktreeGitDir(cwd: string, commonDir: string): Promise<string | null> {
  try {
    const worktreePath = await canonicalPath(cwd);
    const gitFile = resolve(worktreePath, ".git");
    if (!(await lstat(gitFile)).isFile()) return null;
    const pointerMatch = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(await readFile(gitFile, "utf8"));
    if (!pointerMatch?.[1]) return null;
    const reportedGitDir = pointerMatch[1];
    const gitDir = await canonicalPath(
      isAbsolute(reportedGitDir) ? reportedGitDir : resolve(worktreePath, reportedGitDir),
    );
    const backlinkFile = resolve(gitDir, "gitdir");
    if (!isLinkedWorktreeGitDir(commonDir, gitDir) || !(await lstat(backlinkFile)).isFile()) {
      return null;
    }
    const backlinkMatch = /^([^\r\n]+)\r?\n?$/.exec(await readFile(backlinkFile, "utf8"));
    if (!backlinkMatch?.[1]) return null;
    const reportedGitFile = backlinkMatch[1];
    const backlinkPath = await canonicalPath(
      isAbsolute(reportedGitFile) ? reportedGitFile : resolve(gitDir, reportedGitFile),
    );
    return backlinkPath === (await canonicalPath(gitFile)) ? gitDir : null;
  } catch {
    return null;
  }
}

export async function claimedLinkedWorktreeCommonDir(
  repoPath: string,
  cwd: string,
): Promise<string | null> {
  const commonDir = await configuredCommonDir(repoPath);
  if (commonDir === null) return null;
  return (await claimedLinkedWorktreeGitDir(cwd, commonDir)) === null ? null : commonDir;
}

export async function resetClaimedWorktree(
  runner: ProcessRunner,
  cwd: string,
  commonDir: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const gitDir = await claimedLinkedWorktreeGitDir(cwd, commonDir);
  if (gitDir === null) return false;
  await resetPriorWorktreeState(runner, cwd, gitDir, signal);
  return true;
}

export async function removeStaleIndexLock(
  runner: ProcessRunner,
  cwd: string,
  expectedCommonDir: string,
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
    commonDir !== (await canonicalPath(expectedCommonDir)) ||
    !isLinkedWorktreeGitDir(commonDir, gitDir) ||
    (await claimedLinkedWorktreeGitDir(cwd, commonDir)) !== gitDir ||
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
