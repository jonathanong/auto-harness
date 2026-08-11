/**
 * Real-git integration: checkoutRef must support a branch that is already
 * checked out in the primary worktree (documented ref: "main").
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    await client.checkoutRef({ cwd: wt, ref: "main" });
    const head = await client.revParse(wt, "HEAD");
    expect(head).toBe(mainSha);
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
    symlinkSync(repo, linkedRepo);

    const client = createGitClient(new SpawnProcessRunner());
    await client.ensureWorktree({ repoPath: repo, worktreePath: wt, branch: "main" });
    await expect(
      client.ensureWorktree({ repoPath: linkedRepo, worktreePath: wt, branch: "main" }),
    ).resolves.toBeUndefined();
  });
});
