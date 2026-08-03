/**
 * Real-git integration: checkoutRef must support a branch that is already
 * checked out in the primary worktree (documented ref: "main").
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

import { SpawnProcessRunner } from "./executor.ts";
import { createGitClient } from "./git.ts";

function git(cwd: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")}: ${r.stderr || r.stdout}`);
  }
  return r.stdout;
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
    git(repo, ["init"]);
    git(repo, ["config", "user.email", "t@example.com"]);
    git(repo, ["config", "user.name", "t"]);
    writeFileSync(join(repo, "f.txt"), "main\n");
    git(repo, ["add", "f.txt"]);
    git(repo, ["commit", "-m", "init"]);
    git(repo, ["branch", "-M", "main"]);
    // primary is on main
    expect(git(repo, ["branch", "--show-current"]).trim()).toBe("main");
    const mainSha = git(repo, ["rev-parse", "HEAD"]).trim();

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
});
