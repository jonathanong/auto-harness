import { describe, expect, it } from "vitest";

import { canonicalPath, listedWorktreePaths } from "./git-worktree-paths.ts";

describe("git-worktree-paths", () => {
  it("skips a worktree list line with no path after the prefix", async () => {
    // Real `git worktree list --porcelain` never emits a bare "worktree" line,
    // but the parser must not crash or add a bogus empty-path entry if it did.
    const paths = await listedWorktreePaths("worktree \nworktree /repo/wt-1\n", "/repo");
    expect(paths.has(await canonicalPath("/repo/wt-1"))).toBe(true);
    expect(paths.has(await canonicalPath("/repo"))).toBe(false);
    expect(paths.size).toBe(1);
  });

  it("falls back to lexical normalization for a path that does not exist on disk", async () => {
    await expect(canonicalPath("/does/not/exist/anywhere")).resolves.toBe(
      "/does/not/exist/anywhere",
    );
  });
});
