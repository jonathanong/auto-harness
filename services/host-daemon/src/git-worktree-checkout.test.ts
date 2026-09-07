import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { scripted } from "./git-test-helpers.ts";
import { removeStaleIndexLock } from "./git-worktree-checkout.ts";

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
      ),
    ).resolves.toBe(false);
    await expect(
      removeStaleIndexLock(
        lockRunner("/common", "/common/worktrees/one/index.lock", undefined, 0, 1),
        "/repo",
      ),
    ).resolves.toBe(false);
    await expect(
      removeStaleIndexLock(
        lockRunner("/common", "/common/worktrees/one/index.lock", undefined, 0, 0, 1),
        "/repo",
      ),
    ).resolves.toBe(false);
  });

  it("rejects relative paths reported by Git", async () => {
    await expect(
      removeStaleIndexLock(lockRunner("relative", "/common/index.lock"), "/repo"),
    ).resolves.toBe(false);
    await expect(
      removeStaleIndexLock(lockRunner("/common", "/common/index.lock", "relative"), "/repo"),
    ).resolves.toBe(false);
    await expect(
      removeStaleIndexLock(lockRunner("/common", "relative/index.lock"), "/repo"),
    ).resolves.toBe(false);
  });

  it("rejects a different filename and paths outside or equal to the common directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "ah-lock-path-"));
    roots.push(root);
    const commonDir = join(root, "common");
    const gitDir = join(commonDir, "worktrees", "one");
    mkdirSync(gitDir, { recursive: true });
    await expect(
      removeStaleIndexLock(lockRunner(commonDir, join(gitDir, "other.lock"), gitDir), "/repo"),
    ).resolves.toBe(false);
    await expect(
      removeStaleIndexLock(lockRunner(commonDir, join(root, "index.lock"), gitDir), "/repo"),
    ).resolves.toBe(false);
    await expect(
      removeStaleIndexLock(
        lockRunner(commonDir, join(commonDir, "other", "one", "index.lock")),
        "/repo",
      ),
    ).resolves.toBe(false);

    const commonNamedLock = join(root, "index.lock");
    mkdirSync(commonNamedLock);
    await expect(
      removeStaleIndexLock(lockRunner(commonNamedLock, commonNamedLock, commonNamedLock), "/repo"),
    ).resolves.toBe(false);
  });

  it("retries when the resolved lock disappeared and rejects a directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "ah-lock-missing-"));
    roots.push(root);
    const missingCommon = join(root, "missing-common");
    const missingGitDir = join(missingCommon, "worktrees", "one");
    await expect(
      removeStaleIndexLock(
        lockRunner(missingCommon, join(missingGitDir, "index.lock"), missingGitDir),
        "/repo",
      ),
    ).resolves.toBe(true);

    const commonDir = join(root, "common");
    const gitDir = join(commonDir, "worktrees", "one");
    const directoryLock = join(gitDir, "index.lock");
    mkdirSync(directoryLock, { recursive: true });
    await expect(
      removeStaleIndexLock(lockRunner(commonDir, directoryLock, gitDir), "/repo"),
    ).resolves.toBe(false);
  });

  it("fails closed when lock metadata cannot be read", async () => {
    const root = mkdtempSync(join(tmpdir(), "ah-lock-metadata-"));
    roots.push(root);
    const commonDir = join(root, "common");
    const gitDir = join(commonDir, "worktrees", "one");
    mkdirSync(gitDir, { recursive: true });
    const tooLong = join(gitDir, "x".repeat(300), "index.lock");
    await expect(
      removeStaleIndexLock(lockRunner(commonDir, tooLong, dirname(tooLong)), "/repo"),
    ).resolves.toBe(false);
  });

  it("preserves an eligible lock when checkout recovery was cancelled", async () => {
    const root = mkdtempSync(join(tmpdir(), "ah-lock-abort-"));
    roots.push(root);
    const commonDir = join(root, "common");
    const gitDir = join(commonDir, "worktrees", "one");
    const lockPath = join(gitDir, "index.lock");
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(lockPath, "");
    const old = new Date(Date.now() - 60 * 60 * 1_000);
    utimesSync(lockPath, old, old);
    const controller = new AbortController();
    controller.abort();

    await expect(
      removeStaleIndexLock(lockRunner(commonDir, lockPath, gitDir), "/repo", controller.signal),
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
      mkdirSync(worktreeDir, { recursive: true });
      writeFileSync(lockPath, "");
      const old = new Date(Date.now() - 60 * 60 * 1_000);
      utimesSync(lockPath, old, old);
      chmodSync(worktreeDir, 0o555);
      try {
        await expect(
          removeStaleIndexLock(lockRunner(commonDir, lockPath, worktreeDir), "/repo"),
        ).resolves.toBe(false);
      } finally {
        chmodSync(worktreeDir, 0o755);
      }
    },
  );
});
