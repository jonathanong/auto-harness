import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { parseDaemonConfig } from "./config.ts";
import type { GitClient } from "./git.ts";
import { WorktreeManager } from "./worktree-manager.ts";

const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

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
  it("claims and releases worktrees", async () => {
    const git = fakeGit();
    const mgr = new WorktreeManager(config, git);
    const claimed = await mgr.claim("repo-1", "wt-1");
    expect(claimed.cwd).toBe("/repo/wt-1");
    expect(mgr.isBusy("wt-1")).toBe(true);
    await expect(mgr.claim("repo-1", "wt-1")).rejects.toThrow(/busy/);
    mgr.release("wt-1");
    expect(mgr.isBusy("wt-1")).toBe(false);
  });

  it("checks out explicit ref or default branch", async () => {
    const git = fakeGit();
    const mgr = new WorktreeManager(config, git);
    const claimed = await mgr.claim("repo-1", "wt-1");
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

  it("rejects unknown repo or worktree", async () => {
    const git = fakeGit();
    const mgr = new WorktreeManager(config, git);
    await expect(mgr.claim("nope", "wt-1")).rejects.toThrow(/Unknown repository/);
    await expect(mgr.claim("repo-1", "nope")).rejects.toThrow(/Unknown worktree/);
  });

  it("serializes main claims, removes aborted waiters, and tolerates idle release", async () => {
    const mgr = new WorktreeManager(config, fakeGit());
    expect((await mgr.mainClaim("repo-1")).cwd).toBe("/repo");
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
    await expect(mgr.mainClaim("missing")).rejects.toThrow(/Unknown repository/);
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

  it("tolerates already-removed waiters and forwards a main-checkout signal", async () => {
    const git = fakeGit();
    const mgr = new WorktreeManager(config, git);
    expect(await mgr.acquireMain("repo-1")).toBe(true);
    const missingQueue = new AbortController();
    const first = mgr.acquireMain("repo-1", missingQueue.signal);
    const internals = mgr as unknown as { mainWaiters: Map<string, unknown[]> };
    internals.mainWaiters.delete("repo-1");
    missingQueue.abort();

    const missingEntry = new AbortController();
    const second = mgr.acquireMain("repo-1", missingEntry.signal);
    internals.mainWaiters.set("repo-1", []);
    missingEntry.abort();
    mgr.releaseMain("repo-1");
    expect(await Promise.race([first, Promise.resolve("pending")])).toBe("pending");
    expect(await Promise.race([second, Promise.resolve("pending")])).toBe("pending");

    const claimed = await mgr.mainClaim("repo-1");
    const signal = new AbortController().signal;
    await mgr.prepareMainCheckout(claimed, undefined, signal);
    await mgr.prepareMainCheckout(claimed, "release", undefined);
    expect(git.prepareMainCheckout).toHaveBeenCalledWith({ cwd: "/repo", ref: "main", signal });
    expect(git.prepareMainCheckout).toHaveBeenCalledWith({ cwd: "/repo", ref: "release" });
  });

  it("refuses to claim a worktree outside allowed roots and does not mark it busy", async () => {
    const root = join(tmpdir(), `ah-claim-root-${String(Date.now())}`);
    fixtures.push(root);
    await mkdir(root, { recursive: true });
    const jailed = parseDaemonConfig({
      hostId: "a1",
      allowedRoots: [root],
      repositories: [
        {
          id: "repo-1",
          path: join(root, "repo"),
          defaultBranch: "main",
          worktrees: [{ id: "wt-1", name: "wt-1", path: "/etc", labels: [] }],
        },
      ],
    });
    const mgr = new WorktreeManager(jailed, fakeGit());
    await expect(mgr.claim("repo-1", "wt-1")).rejects.toThrow(/outside allowed roots/);
    expect(mgr.isBusy("wt-1")).toBe(false);
    await expect(mgr.mainClaim("repo-1")).resolves.toMatchObject({ cwd: join(root, "repo") });
  });
});
