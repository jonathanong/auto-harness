/* eslint-disable max-lines -- real Git checkout, recovery, and worktree identity cases share one fixture. */
/**
 * Real-git integration: checkoutRef must support a branch that is already
 * checked out in the primary worktree (documented ref: "main").
 */
import {
  chmodSync,
  closeSync,
  existsSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

import { SpawnProcessRunner } from "./executor.ts";
import { createGitClient } from "./git.ts";

async function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (c: Buffer) => {
      stdout += c.toString("utf8");
    });
    child.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (status) => {
      if (status !== 0) {
        reject(new Error(`git ${args.join(" ")}: ${stderr || stdout}`));
        return;
      }
      resolve(stdout);
    });
  });
}

async function createTwoCommitWorktree(root: string): Promise<{
  repo: string;
  targetSha: string;
  worktree: string;
}> {
  const repo = join(root, "repo");
  const worktree = join(root, "wt-1");
  mkdirSync(repo);
  await git(repo, ["init"]);
  await git(repo, ["config", "core.autocrlf", "false"]);
  await git(repo, ["config", "user.email", "t@example.com"]);
  await git(repo, ["config", "user.name", "t"]);
  writeFileSync(join(repo, "tracked.txt"), "first\n");
  await git(repo, ["add", "tracked.txt"]);
  await git(repo, ["commit", "-m", "first"]);
  const firstSha = (await git(repo, ["rev-parse", "HEAD"])).trim();
  await git(repo, ["worktree", "add", "--detach", worktree, firstSha]);
  writeFileSync(join(repo, "tracked.txt"), "target\n");
  writeFileSync(join(repo, "obstructed.txt"), "target-owned\n");
  await git(repo, ["add", "obstructed.txt"]);
  await git(repo, ["commit", "-am", "target"]);
  const targetSha = (await git(repo, ["rev-parse", "HEAD"])).trim();
  return { repo, targetSha, worktree };
}

async function indexLockPath(worktree: string): Promise<string> {
  return (
    await git(worktree, ["rev-parse", "--path-format=absolute", "--git-path", "index.lock"])
  ).trim();
}

function overwriteExistingFile(path: string, contents: string): void {
  chmodSync(path, 0o600);
  const file = openSync(path, "r+");
  try {
    ftruncateSync(file, 0);
    writeFileSync(file, contents);
  } finally {
    closeSync(file);
  }
}

describe("createGitClient real git", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots) {
      rmSync(r, { recursive: true, force: true });
    }
    roots.length = 0;
  });

  it("checkouts main in a secondary worktree while primary is on main", async () => {
    const root = mkdtempSync(join(tmpdir(), "ah-git-main-"));
    roots.push(root);
    const repo = join(root, "repo");
    const wt = join(root, "wt-1");
    mkdirSync(repo);
    await git(repo, ["init"]);
    await git(repo, ["config", "user.email", "t@example.com"]);
    await git(repo, ["config", "user.name", "t"]);
    writeFileSync(join(repo, "f.txt"), "main\n");
    await git(repo, ["add", "f.txt"]);
    await git(repo, ["commit", "-m", "init"]);
    await git(repo, ["branch", "-M", "main"]);
    // primary is on main
    expect((await git(repo, ["branch", "--show-current"])).trim()).toBe("main");
    const mainSha = (await git(repo, ["rev-parse", "HEAD"])).trim();

    const client = createGitClient(new SpawnProcessRunner());
    await client.ensureWorktree({
      repoPath: repo,
      worktreePath: wt,
      branch: "main",
    });
    // This is the documented failure mode before the fix:
    await client.checkoutRef({ cwd: wt, repoPath: repo, ref: "main" });
    const head = await client.revParse(wt, "HEAD");
    expect(head).toBe(mainSha);
  });

  it("recycles tracked state while preserving unrelated untracked files", async () => {
    const root = mkdtempSync(join(tmpdir(), "ah-git-recycle-"));
    roots.push(root);
    const { repo, targetSha, worktree } = await createTwoCommitWorktree(root);
    writeFileSync(join(worktree, "tracked.txt"), "session modification\n");
    writeFileSync(join(worktree, "obstructed.txt"), "untracked obstruction\n");
    writeFileSync(join(worktree, "untracked.txt"), "keep me\n");

    const client = createGitClient(new SpawnProcessRunner());
    await client.checkoutRef({ cwd: worktree, repoPath: repo, ref: targetSha });

    await expect(client.revParse(worktree, "HEAD")).resolves.toBe(targetSha);
    expect(readFileSync(join(worktree, "tracked.txt"), "utf8")).toBe("target\n");
    expect(readFileSync(join(worktree, "obstructed.txt"), "utf8")).toBe("target-owned\n");
    expect(readFileSync(join(worktree, "untracked.txt"), "utf8")).toBe("keep me\n");
  });

  it("clears hidden tracked-file index flags before recycling", async () => {
    const root = mkdtempSync(join(tmpdir(), "ah-git-index-flags-"));
    roots.push(root);
    const { repo, targetSha, worktree } = await createTwoCommitWorktree(root);
    const client = createGitClient(new SpawnProcessRunner());
    await client.checkoutRef({ cwd: worktree, repoPath: repo, ref: targetSha });
    await git(worktree, ["update-index", "--skip-worktree", "tracked.txt"]);
    await git(worktree, ["update-index", "--assume-unchanged", "obstructed.txt"]);
    writeFileSync(join(worktree, "tracked.txt"), "hidden session modification\n");
    writeFileSync(join(worktree, "obstructed.txt"), "assumed session modification\n");

    await client.checkoutRef({ cwd: worktree, repoPath: repo, ref: targetSha });

    expect(readFileSync(join(worktree, "tracked.txt"), "utf8")).toBe("target\n");
    expect(readFileSync(join(worktree, "obstructed.txt"), "utf8")).toBe("target-owned\n");
  });

  it("aborts an interrupted cherry-pick before recycling", async () => {
    const root = mkdtempSync(join(tmpdir(), "ah-git-cherry-pick-"));
    roots.push(root);
    const repo = join(root, "repo");
    const worktree = join(root, "wt");
    mkdirSync(repo);
    await git(repo, ["init"]);
    await git(repo, ["config", "core.autocrlf", "false"]);
    await git(repo, ["config", "user.email", "t@example.com"]);
    await git(repo, ["config", "user.name", "t"]);
    writeFileSync(join(repo, "f.txt"), "base\n");
    await git(repo, ["add", "f.txt"]);
    await git(repo, ["commit", "-m", "base"]);
    const baseSha = (await git(repo, ["rev-parse", "HEAD"])).trim();
    await git(repo, ["switch", "-c", "feature"]);
    writeFileSync(join(repo, "f.txt"), "feature\n");
    await git(repo, ["commit", "-am", "feature"]);
    const featureSha = (await git(repo, ["rev-parse", "HEAD"])).trim();
    await git(repo, ["switch", "-c", "main", baseSha]);
    writeFileSync(join(repo, "f.txt"), "main\n");
    await git(repo, ["commit", "-am", "main"]);
    const mainSha = (await git(repo, ["rev-parse", "HEAD"])).trim();
    await git(repo, ["worktree", "add", "--detach", worktree, mainSha]);
    await expect(git(worktree, ["cherry-pick", featureSha])).rejects.toThrow();
    const cherryPickHead = (
      await git(worktree, ["rev-parse", "--path-format=absolute", "--git-path", "CHERRY_PICK_HEAD"])
    ).trim();
    expect(existsSync(cherryPickHead)).toBe(true);

    await createGitClient(new SpawnProcessRunner()).checkoutRef({
      cwd: worktree,
      repoPath: repo,
      ref: mainSha,
    });

    expect(existsSync(cherryPickHead)).toBe(false);
    expect(readFileSync(join(worktree, "f.txt"), "utf8")).toBe("main\n");
  });

  it("recycles tracked changes in initialized submodules", async () => {
    const root = mkdtempSync(join(tmpdir(), "ah-git-submodule-"));
    roots.push(root);
    const submodule = join(root, "submodule");
    const repo = join(root, "repo");
    const worktree = join(root, "wt");
    mkdirSync(submodule);
    await git(submodule, ["init"]);
    await git(submodule, ["config", "core.autocrlf", "false"]);
    await git(submodule, ["config", "user.email", "t@example.com"]);
    await git(submodule, ["config", "user.name", "t"]);
    writeFileSync(join(submodule, "tracked.txt"), "recorded\n");
    await git(submodule, ["add", "tracked.txt"]);
    await git(submodule, ["commit", "-m", "initial"]);

    mkdirSync(repo);
    await git(repo, ["init"]);
    await git(repo, ["config", "core.autocrlf", "false"]);
    await git(repo, ["config", "user.email", "t@example.com"]);
    await git(repo, ["config", "user.name", "t"]);
    await git(repo, ["-c", "protocol.file.allow=always", "submodule", "add", submodule, "sub"]);
    await git(repo, ["commit", "-am", "add submodule"]);
    const targetSha = (await git(repo, ["rev-parse", "HEAD"])).trim();
    await git(repo, ["worktree", "add", "--detach", worktree, targetSha]);
    await git(worktree, ["-c", "protocol.file.allow=always", "submodule", "update", "--init"]);
    await git(join(worktree, "sub"), ["config", "core.autocrlf", "false"]);
    writeFileSync(join(worktree, "sub", "tracked.txt"), "session modification\n");

    await createGitClient(new SpawnProcessRunner()).checkoutRef({
      cwd: worktree,
      repoPath: repo,
      ref: targetSha,
    });

    expect(readFileSync(join(worktree, "sub", "tracked.txt"), "utf8")).toBe("recorded\n");
  });

  it("rejects a linked-worktree pointer whose backlink belongs to another worktree", async () => {
    const root = mkdtempSync(join(tmpdir(), "ah-git-identity-"));
    roots.push(root);
    const { repo, targetSha, worktree } = await createTwoCommitWorktree(root);
    const victim = join(root, "victim");
    await git(repo, ["worktree", "add", "--detach", victim, targetSha]);
    const victimLock = await indexLockPath(victim);
    writeFileSync(victimLock, "");
    const old = new Date(Date.now() - 60 * 60 * 1_000);
    utimesSync(victimLock, old, old);
    overwriteExistingFile(join(worktree, ".git"), readFileSync(join(victim, ".git"), "utf8"));

    await expect(
      createGitClient(new SpawnProcessRunner()).checkoutRef({
        cwd: worktree,
        repoPath: repo,
        ref: targetSha,
      }),
    ).rejects.toThrow("Configured checkout is not the claimed linked worktree");
    expect(existsSync(victimLock)).toBe(true);
  });

  it("rejects a self-consistent linked-worktree pointer from another repository", async () => {
    const root = mkdtempSync(join(tmpdir(), "ah-git-foreign-identity-"));
    roots.push(root);
    const { repo, targetSha, worktree } = await createTwoCommitWorktree(root);
    const foreignRoot = join(root, "foreign");
    mkdirSync(foreignRoot);
    const { worktree: foreignWorktree } = await createTwoCommitWorktree(foreignRoot);
    const foreignLock = await indexLockPath(foreignWorktree);
    const foreignGitDir = dirname(foreignLock);
    writeFileSync(foreignLock, "");
    const old = new Date(Date.now() - 60 * 60 * 1_000);
    utimesSync(foreignLock, old, old);
    overwriteExistingFile(join(worktree, ".git"), `gitdir: ${foreignGitDir}\n`);
    writeFileSync(join(foreignGitDir, "gitdir"), `${join(worktree, ".git")}\n`);

    await expect(
      createGitClient(new SpawnProcessRunner()).checkoutRef({
        cwd: worktree,
        repoPath: repo,
        ref: targetSha,
      }),
    ).rejects.toThrow("Configured checkout is not the claimed linked worktree");
    expect(existsSync(foreignLock)).toBe(true);
  });

  it("removes an old empty index lock and retries checkout", async () => {
    const root = mkdtempSync(join(tmpdir(), "ah-git-stale-lock-"));
    roots.push(root);
    const { repo, targetSha, worktree } = await createTwoCommitWorktree(root);
    const lockPath = await indexLockPath(worktree);
    writeFileSync(lockPath, "");
    const old = new Date(Date.now() - 60 * 60 * 1_000);
    utimesSync(lockPath, old, old);

    const client = createGitClient(new SpawnProcessRunner());
    await client.checkoutRef({ cwd: worktree, repoPath: repo, ref: targetSha });

    expect(existsSync(lockPath)).toBe(false);
    await expect(client.revParse(worktree, "HEAD")).resolves.toBe(targetSha);
  });

  it("preserves a fresh empty index lock", async () => {
    const root = mkdtempSync(join(tmpdir(), "ah-git-fresh-lock-"));
    roots.push(root);
    const { repo, targetSha, worktree } = await createTwoCommitWorktree(root);
    const lockPath = await indexLockPath(worktree);
    writeFileSync(lockPath, "");

    const checkout = createGitClient(new SpawnProcessRunner()).checkoutRef({
      cwd: worktree,
      repoPath: repo,
      ref: targetSha,
    });

    await expect(checkout).rejects.toThrow(/Failed to clear tracked-file index flags.*index\.lock/);
    expect(existsSync(lockPath)).toBe(true);
  });

  it("preserves a non-empty old index lock", async () => {
    const root = mkdtempSync(join(tmpdir(), "ah-git-nonempty-lock-"));
    roots.push(root);
    const { repo, targetSha, worktree } = await createTwoCommitWorktree(root);
    const lockPath = await indexLockPath(worktree);
    writeFileSync(lockPath, "owner");
    const old = new Date(Date.now() - 60 * 60 * 1_000);
    utimesSync(lockPath, old, old);

    const checkout = createGitClient(new SpawnProcessRunner()).checkoutRef({
      cwd: worktree,
      repoPath: repo,
      ref: targetSha,
    });

    await expect(checkout).rejects.toThrow(/Failed to clear tracked-file index flags.*index\.lock/);
    expect(readFileSync(lockPath, "utf8")).toBe("owner");
  });

  it("preserves an old index lock symlink", async () => {
    const root = mkdtempSync(join(tmpdir(), "ah-git-symlink-lock-"));
    roots.push(root);
    const { repo, targetSha, worktree } = await createTwoCommitWorktree(root);
    const lockPath = await indexLockPath(worktree);
    const target = join(root, "lock-target");
    writeFileSync(target, "");
    const old = new Date(Date.now() - 60 * 60 * 1_000);
    utimesSync(target, old, old);
    symlinkSync(target, lockPath);

    const checkout = createGitClient(new SpawnProcessRunner()).checkoutRef({
      cwd: worktree,
      repoPath: repo,
      ref: targetSha,
    });

    await expect(checkout).rejects.toThrow(/Failed to clear tracked-file index flags.*index\.lock/);
    expect(existsSync(lockPath)).toBe(true);
  });

  it("peels an annotated tag before detaching at its commit", async () => {
    const root = mkdtempSync(join(tmpdir(), "ah-git-tag-"));
    roots.push(root);
    const repo = join(root, "repo");
    mkdirSync(repo);
    await git(repo, ["init"]);
    await git(repo, ["config", "user.email", "t@example.com"]);
    await git(repo, ["config", "user.name", "t"]);
    writeFileSync(join(repo, "f.txt"), "main\n");
    await git(repo, ["add", "f.txt"]);
    await git(repo, ["commit", "-m", "init"]);
    await git(repo, ["tag", "-a", "v1.2.3", "-m", "release"]);
    const tagCommit = (await git(repo, ["rev-parse", "v1.2.3^{commit}"])).trim();
    const worktree = join(root, "wt");
    await git(repo, ["worktree", "add", "--detach", worktree, tagCommit]);

    const client = createGitClient(new SpawnProcessRunner());
    await client.checkoutRef({ cwd: worktree, repoPath: repo, ref: "v1.2.3" });

    await expect(client.revParse(worktree, "HEAD")).resolves.toBe(tagCommit);
  });

  it("fetches missing tree objects after an exact-SHA checkout fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "ah-git-missing-tree-"));
    roots.push(root);
    const source = join(root, "source");
    const remote = join(root, "remote.git");
    const clientPath = join(root, "client");
    const commitFile = join(root, "target-commit");
    mkdirSync(source);
    await git(source, ["init"]);
    await git(source, ["config", "user.email", "t@example.com"]);
    await git(source, ["config", "user.name", "t"]);
    writeFileSync(join(source, "f.txt"), "target\n");
    await git(source, ["add", "f.txt"]);
    await git(source, ["commit", "-m", "target"]);
    await git(source, ["branch", "-M", "main"]);
    const targetSha = (await git(source, ["rev-parse", "HEAD"])).trim();
    await git(root, ["clone", "--bare", source, remote]);
    await git(root, ["clone", "--no-checkout", remote, clientPath]);
    const worktree = join(root, "client-wt");
    await git(clientPath, ["worktree", "add", "--detach", worktree, targetSha]);

    const targetCommit = await git(clientPath, ["cat-file", "commit", targetSha]);
    rmSync(join(clientPath, ".git", "objects"), { recursive: true, force: true });
    mkdirSync(join(clientPath, ".git", "objects"));
    writeFileSync(join(worktree, "f.txt"), "dirty\n");
    writeFileSync(commitFile, targetCommit);
    expect((await git(clientPath, ["hash-object", "-t", "commit", "-w", commitFile])).trim()).toBe(
      targetSha,
    );
    await expect(git(clientPath, ["cat-file", "-e", `${targetSha}^{tree}`])).rejects.toThrow();

    const client = createGitClient(new SpawnProcessRunner());
    await client.checkoutRef({ cwd: worktree, repoPath: clientPath, ref: targetSha });
    await expect(client.revParse(worktree, "HEAD")).resolves.toBe(targetSha);
  });

  it("recognizes an absolute worktree when the repository path is a symlink", async () => {
    const root = mkdtempSync(join(tmpdir(), "ah-git-link-"));
    const externalRoot = mkdtempSync(join(tmpdir(), "ah-git-external-"));
    roots.push(root, externalRoot);
    const repo = join(root, "nested", "repo");
    const linkedRepo = join(root, "repo-link");
    const wt = join(externalRoot, "wt-1");
    mkdirSync(repo, { recursive: true });
    await git(repo, ["init"]);
    await git(repo, ["config", "user.email", "t@example.com"]);
    await git(repo, ["config", "user.name", "t"]);
    writeFileSync(join(repo, "f.txt"), "main\n");
    await git(repo, ["add", "f.txt"]);
    await git(repo, ["commit", "-m", "init"]);
    await git(repo, ["branch", "-M", "main"]);
    symlinkSync(repo, linkedRepo, process.platform === "win32" ? "junction" : "dir");

    const client = createGitClient(new SpawnProcessRunner());
    await client.ensureWorktree({ repoPath: repo, worktreePath: wt, branch: "main" });
    await expect(
      client.ensureWorktree({ repoPath: linkedRepo, worktreePath: wt, branch: "main" }),
    ).resolves.toBeUndefined();
  });
});
