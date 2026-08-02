import { describe, expect, it, vi } from "vitest";

import { parseAgentConfig } from "./config.js";
import type { GitClient } from "./git.js";
import { WorktreeManager } from "./worktree-manager.js";

function fakeGit(): GitClient & {
  checkouts: string[];
} {
  const checkouts: string[] = [];
  return {
    checkouts,
    ensureRepo: vi.fn(async () => undefined),
    ensureWorktree: vi.fn(async () => undefined),
    checkoutRef: vi.fn(async ({ ref }) => {
      checkouts.push(ref);
    }),
    revParse: vi.fn(async () => "abc"),
  };
}

const config = parseAgentConfig({
  agentId: "a1",
  commandProfiles: { echo: { argv: ["echo"], appendPrompt: true } },
  repositories: [
    {
      id: "repo-1",
      path: "/repo",
      defaultBranch: "main",
      worktrees: [{ id: "wt-1", path: "/repo/wt-1", labels: ["codex"] }],
    },
  ],
});

describe("WorktreeManager", () => {
  it("claims and releases worktrees", () => {
    const git = fakeGit();
    const mgr = new WorktreeManager(config, git);
    const claimed = mgr.claim("repo-1", "wt-1");
    expect(claimed.cwd).toBe("/repo/wt-1");
    expect(mgr.isBusy("wt-1")).toBe(true);
    expect(() => mgr.claim("repo-1", "wt-1")).toThrow(/busy/);
    mgr.release("wt-1");
    expect(mgr.isBusy("wt-1")).toBe(false);
  });

  it("checks out explicit ref or default branch", async () => {
    const git = fakeGit();
    const mgr = new WorktreeManager(config, git);
    const claimed = mgr.claim("repo-1", "wt-1");
    await mgr.prepareCheckout(claimed, "feature/x");
    await mgr.prepareCheckout(claimed, undefined);
    expect(git.checkouts).toEqual(["feature/x", "main"]);
    mgr.release("wt-1");
  });

  it("ensureAll probes repo and worktrees", async () => {
    const git = fakeGit();
    const mgr = new WorktreeManager(config, git);
    await mgr.ensureAll();
    expect(git.ensureRepo).toHaveBeenCalledWith("/repo");
    expect(git.ensureWorktree).toHaveBeenCalled();
  });

  it("rejects unknown repo or worktree", () => {
    const git = fakeGit();
    const mgr = new WorktreeManager(config, git);
    expect(() => mgr.claim("nope", "wt-1")).toThrow(/Unknown repository/);
    expect(() => mgr.claim("repo-1", "nope")).toThrow(/Unknown worktree/);
  });
});
