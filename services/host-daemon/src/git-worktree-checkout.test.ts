/* eslint-disable max-lines -- stale-lock safety cases share filesystem-backed identity fixtures. */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { scripted } from "../test-helpers/git-test-helpers.ts";
import { claimedLinkedWorktreeCommonDir, removeStaleIndexLock } from "./git-worktree-checkout.ts";

function writeWorktreeIdentity(cwd: string, gitDir: string): void {
  mkdirSync(cwd, { recursive: true });
  mkdirSync(gitDir, { recursive: true });
  writeFileSync(join(cwd, ".git"), `gitdir: ${gitDir}\n`);
  writeFileSync(join(gitDir, "gitdir"), `${join(cwd, ".git")}\n`);
}

function lockRunner(
  commonDir: string,
  lockPath: string,
  gitDir = dirname(lockPath),
  commonExit = 0,
  gitDirExit = 0,
  lockExit = 0,
) {
  return scripted([
    {
      match: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      exitCode: commonExit,
      stdout: `${commonDir}\n`,
    },
    {
      match: ["rev-parse", "--path-format=absolute", "--git-dir"],
      exitCode: gitDirExit,
      stdout: `${gitDir}\n`,
    },
    {
      match: ["rev-parse", "--path-format=absolute", "--git-path", "index.lock"],
      exitCode: lockExit,
      stdout: `${lockPath}\n`,
    },
  ]);
}

describe("stale worktree index lock safety", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
    roots.length = 0;
  });

  it("fails closed when Git cannot resolve either administrative path", async () => {
    await expect(
      removeStaleIndexLock(
        lockRunner("/common", "/common/worktrees/one/index.lock", undefined, 1),
        "/repo",
        "/common",
      ),
    ).resolves.toBe(false);
    await expect(
      removeStaleIndexLock(
        lockRunner("/common", "/common/worktrees/one/index.lock", undefined, 0, 1),
        "/repo",
        "/common",
      ),
    ).resolves.toBe(false);
    await expect(
      removeStaleIndexLock(
        lockRunner("/common", "/common/worktrees/one/index.lock", undefined, 0, 0, 1),
        "/repo",
        "/common",
      ),
    ).resolves.toBe(false);
  });

  it("rejects relative paths reported by Git", async () => {
    await expect(
      removeStaleIndexLock(lockRunner("relative", "/common/index.lock"), "/repo", "/common"),
    ).resolves.toBe(false);
    await expect(
      removeStaleIndexLock(
        lockRunner("/common", "/common/index.lock", "relative"),
        "/repo",
        "/common",
      ),
    ).resolves.toBe(false);
    await expect(
      removeStaleIndexLock(lockRunner("/common", "relative/index.lock"), "/repo", "/common"),
    ).resolves.toBe(false);
  });

  it("rejects a different filename and paths outside or equal to the common directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "ah-lock-path-"));
    roots.push(root);
    const commonDir = join(root, "common");
    const gitDir = join(commonDir, "worktrees", "one");
    mkdirSync(gitDir, { recursive: true });
    await expect(
      removeStaleIndexLock(
        lockRunner(commonDir, join(gitDir, "other.lock"), gitDir),
        "/repo",
        commonDir,
      ),
    ).resolves.toBe(false);
    await expect(
      removeStaleIndexLock(
        lockRunner(commonDir, join(root, "index.lock"), gitDir),
        "/repo",
        commonDir,
      ),
    ).resolves.toBe(false);
    await expect(
      removeStaleIndexLock(
        lockRunner(commonDir, join(commonDir, "other", "one", "index.lock")),
        "/repo",
        commonDir,
      ),
    ).resolves.toBe(false);

    const commonNamedLock = join(root, "index.lock");
    mkdirSync(commonNamedLock);
    await expect(
      removeStaleIndexLock(
        lockRunner(commonNamedLock, commonNamedLock, commonNamedLock),
        "/repo",
        commonNamedLock,
      ),
    ).resolves.toBe(false);
  });

  it("retries when the resolved lock disappeared and rejects a directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "ah-lock-missing-"));
    roots.push(root);
    const missingCommon = join(root, "missing-common");
    const missingGitDir = join(missingCommon, "worktrees", "one");
    const missingCwd = join(root, "missing-cwd");
    writeWorktreeIdentity(missingCwd, missingGitDir);
    await expect(
      removeStaleIndexLock(
        lockRunner(missingCommon, join(missingGitDir, "index.lock"), missingGitDir),
        missingCwd,
        missingCommon,
      ),
    ).resolves.toBe(true);

    const commonDir = join(root, "common");
    const gitDir = join(commonDir, "worktrees", "one");
    const directoryLock = join(gitDir, "index.lock");
    const directoryCwd = join(root, "directory-cwd");
    writeWorktreeIdentity(directoryCwd, gitDir);
    mkdirSync(directoryLock);
    await expect(
      removeStaleIndexLock(lockRunner(commonDir, directoryLock, gitDir), directoryCwd, commonDir),
    ).resolves.toBe(false);
  });

  it("rejects an admin directory whose backlink belongs to another worktree", async () => {
    const root = mkdtempSync(join(tmpdir(), "ah-lock-identity-"));
    roots.push(root);
    const repoPath = join(root, "repo");
    const commonDir = join(repoPath, ".git");
    const victimGitDir = join(commonDir, "worktrees", "victim");
    const victimCwd = join(root, "victim");
    const claimedCwd = join(root, "claimed");
    writeWorktreeIdentity(victimCwd, victimGitDir);
    mkdirSync(claimedCwd);
    writeFileSync(join(claimedCwd, ".git"), `gitdir: ${victimGitDir}\n`);
    const lockPath = join(victimGitDir, "index.lock");
    writeFileSync(lockPath, "");
    const old = new Date(Date.now() - 60 * 60 * 1_000);
    utimesSync(lockPath, old, old);

    await expect(claimedLinkedWorktreeCommonDir(repoPath, claimedCwd)).resolves.toBeNull();
    await expect(
      removeStaleIndexLock(lockRunner(commonDir, lockPath, victimGitDir), claimedCwd, commonDir),
    ).resolves.toBe(false);
    expect(existsSync(lockPath)).toBe(true);
  });

  it("accepts relative identity links and rejects malformed identity files", async () => {
    const root = mkdtempSync(join(tmpdir(), "ah-lock-relative-"));
    roots.push(root);
    const repoPath = join(root, "repo");
    const cwd = join(root, "cwd");
    const gitDir = join(repoPath, ".git", "worktrees", "one");
    writeWorktreeIdentity(cwd, gitDir);
    writeFileSync(join(cwd, ".git"), `gitdir: ${relative(cwd, gitDir)}\n`);
    writeFileSync(join(gitDir, "gitdir"), `${relative(gitDir, join(cwd, ".git"))}\n`);
    await expect(claimedLinkedWorktreeCommonDir(repoPath, cwd)).resolves.toBe(
      realpathSync(join(repoPath, ".git")),
    );

    writeFileSync(join(gitDir, "gitdir"), "two\nlines\n");
    await expect(claimedLinkedWorktreeCommonDir(repoPath, cwd)).resolves.toBeNull();
    writeFileSync(join(cwd, ".git"), "not a gitdir pointer\n");
    await expect(claimedLinkedWorktreeCommonDir(repoPath, cwd)).resolves.toBeNull();
    rmSync(join(cwd, ".git"));
    mkdirSync(join(cwd, ".git"));
    await expect(claimedLinkedWorktreeCommonDir(repoPath, cwd)).resolves.toBeNull();

    const wrongShapeCwd = join(root, "wrong-shape");
    const wrongShapeGitDir = join(repoPath, ".git", "other", "one");
    writeWorktreeIdentity(wrongShapeCwd, wrongShapeGitDir);
    await expect(claimedLinkedWorktreeCommonDir(repoPath, wrongShapeCwd)).resolves.toBeNull();
  });

  it("rejects an unreadable linked-worktree administration directory", async () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "ah-lock-unreadable-"));
    roots.push(root);
    const repoPath = join(root, "repo");
    const cwd = join(root, "cwd");
    const gitDir = join(repoPath, ".git", "worktrees", "one");
    writeWorktreeIdentity(cwd, gitDir);
    chmodSync(gitDir, 0o000);
    try {
      await expect(claimedLinkedWorktreeCommonDir(repoPath, cwd)).resolves.toBeNull();
    } finally {
      chmodSync(gitDir, 0o755);
    }
  });

  it("resolves a linked configured repository and rejects unsafe repository metadata", async () => {
    const root = mkdtempSync(join(tmpdir(), "ah-repo-identity-"));
    roots.push(root);
    const commonDir = join(root, "common");
    const repoPath = join(root, "configured-repo");
    const repoGitDir = join(commonDir, "worktrees", "configured");
    const cwd = join(root, "cwd");
    const gitDir = join(commonDir, "worktrees", "one");
    writeWorktreeIdentity(repoPath, repoGitDir);
    writeWorktreeIdentity(cwd, gitDir);
    writeFileSync(join(repoPath, ".git"), `gitdir: ${relative(repoPath, repoGitDir)}\n`);
    await expect(claimedLinkedWorktreeCommonDir(repoPath, cwd)).resolves.toBe(
      realpathSync(commonDir),
    );

    writeFileSync(join(repoPath, ".git"), "not a gitdir pointer\n");
    await expect(claimedLinkedWorktreeCommonDir(repoPath, cwd)).resolves.toBeNull();
    const wrongAdmin = join(root, "other", "configured");
    mkdirSync(wrongAdmin, { recursive: true });
    writeFileSync(join(wrongAdmin, "gitdir"), `${join(repoPath, ".git")}\n`);
    writeFileSync(join(repoPath, ".git"), `gitdir: ${wrongAdmin}\n`);
    await expect(claimedLinkedWorktreeCommonDir(repoPath, cwd)).resolves.toBeNull();
    const notDirectory = join(root, "not-directory");
    writeFileSync(notDirectory, "not a Git directory");
    writeFileSync(join(repoPath, ".git"), `gitdir: ${notDirectory}\n`);
    await expect(claimedLinkedWorktreeCommonDir(repoPath, cwd)).resolves.toBeNull();
    rmSync(join(repoPath, ".git"));
    symlinkSync(join(repoGitDir, "gitdir"), join(repoPath, ".git"));
    await expect(claimedLinkedWorktreeCommonDir(repoPath, cwd)).resolves.toBeNull();
    await expect(claimedLinkedWorktreeCommonDir(join(root, "missing"), cwd)).resolves.toBeNull();
  });

  it("accepts a configured repository with a separate Git directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "ah-separate-git-dir-"));
    roots.push(root);
    const repoPath = join(root, "repo");
    const commonDir = join(root, "separate-git-dir");
    const cwd = join(root, "cwd");
    const gitDir = join(commonDir, "worktrees", "one");
    mkdirSync(repoPath);
    writeWorktreeIdentity(cwd, gitDir);
    writeFileSync(join(repoPath, ".git"), `gitdir: ${commonDir}\n`);

    await expect(claimedLinkedWorktreeCommonDir(repoPath, cwd)).resolves.toBe(
      realpathSync(commonDir),
    );
  });

  it("fails closed when lock metadata cannot be read", async () => {
    const root = mkdtempSync(join(tmpdir(), "ah-lock-metadata-"));
    roots.push(root);
    const commonDir = join(root, "common");
    const gitDir = join(commonDir, "worktrees", "one");
    mkdirSync(gitDir, { recursive: true });
    const tooLong = join(gitDir, "x".repeat(300), "index.lock");
    await expect(
      removeStaleIndexLock(lockRunner(commonDir, tooLong, dirname(tooLong)), "/repo", commonDir),
    ).resolves.toBe(false);
  });

  it("preserves an eligible lock when checkout recovery was cancelled", async () => {
    const root = mkdtempSync(join(tmpdir(), "ah-lock-abort-"));
    roots.push(root);
    const commonDir = join(root, "common");
    const gitDir = join(commonDir, "worktrees", "one");
    const lockPath = join(gitDir, "index.lock");
    const cwd = join(root, "cwd");
    writeWorktreeIdentity(cwd, gitDir);
    writeFileSync(lockPath, "");
    const old = new Date(Date.now() - 60 * 60 * 1_000);
    utimesSync(lockPath, old, old);
    const controller = new AbortController();
    controller.abort();

    await expect(
      removeStaleIndexLock(
        lockRunner(commonDir, lockPath, gitDir),
        cwd,
        commonDir,
        controller.signal,
      ),
    ).resolves.toBe(false);
    expect(existsSync(lockPath)).toBe(true);
  });

  it.runIf(process.platform !== "win32")(
    "fails closed when an eligible lock cannot be removed",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "ah-lock-unlink-"));
      roots.push(root);
      const commonDir = join(root, "common");
      const worktreeDir = join(commonDir, "worktrees", "one");
      const lockPath = join(worktreeDir, "index.lock");
      const cwd = join(root, "cwd");
      writeWorktreeIdentity(cwd, worktreeDir);
      writeFileSync(lockPath, "");
      const old = new Date(Date.now() - 60 * 60 * 1_000);
      utimesSync(lockPath, old, old);
      chmodSync(worktreeDir, 0o555);
      try {
        await expect(
          removeStaleIndexLock(lockRunner(commonDir, lockPath, worktreeDir), cwd, commonDir),
        ).resolves.toBe(false);
      } finally {
        chmodSync(worktreeDir, 0o755);
      }
    },
  );
});
