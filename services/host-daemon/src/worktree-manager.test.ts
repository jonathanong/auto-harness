import { describe, expect, it, vi } from "vitest";

import { parseDaemonConfig } from "./config.ts";
import type { GitClient } from "./git.ts";
import { WorktreeManager } from "./worktree-manager.ts";

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
    prepareMainCheckout: vi.fn(async () => undefined),
    revParse: vi.fn(async () => "abc"),
  };
}

const config = parseDaemonConfig({
  hostId: "a1",
  commandProfiles: { echo: { argv: ["echo"], appendPrompt: true } },
  repositories: [
    {
      id: "repo-1",
      path: "/repo",
      defaultBranch: "main",
      worktrees: [{ id: "wt-1", name: "wt-1", path: "/repo/wt-1", labels: ["codex"] }],
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

  it("serializes main claims, removes aborted waiters, and tolerates idle release", async () => {
    const mgr = new WorktreeManager(config, fakeGit());
    expect(mgr.mainClaim("repo-1").cwd).toBe("/repo");
    expect(await mgr.acquireMain("repo-1")).toBe(true);
    const controller = new AbortController();
    const canceled = mgr.acquireMain("repo-1", controller.signal);
    controller.abort();
    await expect(canceled).resolves.toBe(false);
    const next = mgr.acquireMain("repo-1");
    mgr.releaseMain("repo-1");
    await expect(next).resolves.toBe(true);
    mgr.releaseMain("repo-1");
    mgr.releaseMain("repo-1");
    expect(await mgr.acquireMain("repo-1", AbortSignal.abort())).toBe(false);
    expect(() => mgr.mainClaim("missing")).toThrow(/Unknown repository/);
  });

  it("skips a stale aborted waiter when releasing a lock", async () => {
    const mgr = new WorktreeManager(config, fakeGit());
    expect(await mgr.acquireMain("repo-1")).toBe(true);
    let stale = false;
    let live = false;
    const internals = mgr as unknown as {
      mainWaiters: Map<
        string,
        Array<{ resolve: (acquired: boolean) => void; signal?: AbortSignal }>
      >;
    };
    internals.mainWaiters.set("repo-1", [
      { resolve: () => void (stale = true), signal: AbortSignal.abort() },
      { resolve: () => void (live = true) },
    ]);
    mgr.releaseMain("repo-1");
    expect(stale).toBe(true);
    expect(live).toBe(true);
    mgr.releaseMain("repo-1");
  });
});
