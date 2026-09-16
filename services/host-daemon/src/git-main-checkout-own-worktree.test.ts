import { describe, expect, it } from "vitest";

import { createGitClient } from "./git.ts";
import { scripted } from "../test-helpers/git-test-helpers.ts";

describe("createGitClient main checkout own-worktree dirt", () => {
  it("ignores its own registered worktree directory but still refuses real uncommitted work", async () => {
    const worktreeList = "worktree /repo\nworktree /repo/.worktrees/wt-1\n";
    // Ignored: `.worktrees/wt-1` is a daemon-created linked worktree of this repo.
    const clean = createGitClient(
      scripted([
        { match: ["check-ref-format", "--branch", "main"], exitCode: 0 },
        {
          match: ["status", "--porcelain", "-z", "--untracked-files=all"],
          exitCode: 0,
          stdout: "?? .worktrees/wt-1/\0",
        },
        { match: ["worktree", "list", "--porcelain"], exitCode: 0, stdout: worktreeList },
        { match: ["show-ref", "--verify", "--quiet", "refs/heads/main"], exitCode: 0 },
        { match: ["switch", "--", "main"], exitCode: 0 },
        { match: ["symbolic-ref", "--quiet", "--short", "HEAD"], exitCode: 0, stdout: "main\n" },
      ]),
    );
    await expect(clean.prepareMainCheckout({ cwd: "/repo", ref: "main" })).resolves.toBeUndefined();

    // Not ignored: an untracked file that merely sits next to a registered worktree
    // is real content the guard must still catch.
    const stillDirty = createGitClient(
      scripted([
        { match: ["check-ref-format", "--branch", "main"], exitCode: 0 },
        {
          match: ["status", "--porcelain", "-z", "--untracked-files=all"],
          exitCode: 0,
          stdout: "?? .worktrees/wt-1/\0?? secret.env\0",
        },
        { match: ["worktree", "list", "--porcelain"], exitCode: 0, stdout: worktreeList },
      ]),
    );
    await expect(stillDirty.prepareMainCheckout({ cwd: "/repo", ref: "main" })).rejects.toThrow(
      /uncommitted changes \(\?\? secret\.env\)/,
    );
  });

  it("fails closed (does not ignore anything) when the worktree list itself cannot be read", async () => {
    const client = createGitClient(
      scripted([
        { match: ["check-ref-format", "--branch", "main"], exitCode: 0 },
        {
          match: ["status", "--porcelain", "-z", "--untracked-files=all"],
          exitCode: 0,
          stdout: "?? .worktrees/wt-1/\0",
        },
        { match: ["worktree", "list", "--porcelain"], exitCode: 1 },
      ]),
    );
    await expect(client.prepareMainCheckout({ cwd: "/repo", ref: "main" })).rejects.toThrow(
      /uncommitted changes \(\?\? \.worktrees\/wt-1\/\)/,
    );
  });
});
