/* eslint-disable max-lines -- claim policy regressions share this focused manager fixture. */
import { mkdir, realpath, rm, symlink } from "node:fs/promises";
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
    await mkdir(join(root, "repo"), { recursive: true });
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
    await expect(mgr.mainClaim("repo-1")).resolves.toMatchObject({
      cwd: await realpath(join(root, "repo")),
    });
  });

  it("propagates canonical repository and worktree paths into a claim", async () => {
    const root = join(tmpdir(), `ah-canonical-claim-${String(Date.now())}`);
    fixtures.push(root);
    const repository = join(root, "repository");
    const worktree = join(repository, "worktree");
    await mkdir(worktree, { recursive: true });
    const repositoryLink = join(root, "repository-link");
    const worktreeLink = join(root, "worktree-link");
    await symlink(repository, repositoryLink);
    await symlink(worktree, worktreeLink);
    const jailed = parseDaemonConfig({
      hostId: "a1",
      allowedRoots: [root],
      repositories: [
        {
          id: "repo-1",
          path: repositoryLink,
          defaultBranch: "main",
          worktrees: [{ id: "wt-1", name: "wt-1", path: worktreeLink, labels: [] }],
        },
      ],
    });
    const git = fakeGit();
    const claimed = await new WorktreeManager(jailed, git).claim("repo-1", "wt-1");
    expect(claimed.cwd).toBe(await realpath(worktree));
    expect(claimed.repository.path).toBe(await realpath(repository));
    expect(claimed.worktree.path).toBe(await realpath(worktree));
    const outside = join(root, "outside");
    await mkdir(outside);
    await rm(worktreeLink);
    await symlink(outside, worktreeLink);
    await new WorktreeManager(jailed, git).prepareCheckout(claimed, "main");
    expect(git.checkoutRef).toHaveBeenCalledWith({ cwd: await realpath(worktree), ref: "main" });
  });

  it("fails closed for a pending hook while an invalid roots policy is retained", async () => {
    const jailed = parseDaemonConfig({
      hostId: "a1",
      repositories: [
        {
          id: "repo-1",
          path: "/repo",
          defaultBranch: "main",
          terminalHookScript: "/repo/hook.sh",
          worktrees: [{ id: "wt-1", name: "wt-1", path: "/repo/wt-1", labels: [] }],
        },
      ],
    });
    const manager = new WorktreeManager(jailed, fakeGit());
    const claimed = await manager.claim("repo-1", "wt-1");
    manager.setAllowedRootsPolicy([]);
    await expect(claimed.currentHookTarget()).resolves.toBeNull();
    await expect(claimed.currentExecutionTarget()).rejects.toThrow(
      "host inventory changed after this checkout was claimed",
    );
  });

  it("fails closed for claims and startup preparation while an empty policy is active", async () => {
    const manager = new WorktreeManager(config, fakeGit());
    manager.setAllowedRootsPolicy([]);
    await expect(manager.claim("repo-1", "wt-1")).rejects.toThrow(
      "host inventory policy blocks execution",
    );
    await expect(manager.mainClaim("repo-1")).rejects.toThrow(
      "host inventory policy blocks execution",
    );
    await expect(manager.ensureAll()).rejects.toThrow("host inventory policy blocks execution");
  });

  it("stops claim retries when the session is already cancelled", async () => {
    const signal = AbortSignal.abort();
    const manager = new WorktreeManager(config, fakeGit());
    await expect(manager.claim("repo-1", "wt-1", signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    await expect(manager.mainClaim("repo-1", signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(manager.isBusy("wt-1")).toBe(false);
  });

  it("refuses checkout when the roots policy changes after a claim", async () => {
    const root = join(tmpdir(), `ah-claim-policy-change-${String(Date.now())}`);
    fixtures.push(root);
    const repository = join(root, "repository");
    const worktree = join(repository, "worktree");
    await mkdir(worktree, { recursive: true });
    const jailed = parseDaemonConfig({
      hostId: "a1",
      allowedRoots: [root],
      repositories: [
        {
          id: "repo-1",
          path: repository,
          defaultBranch: "main",
          worktrees: [{ id: "wt-1", name: "wt-1", path: worktree, labels: [] }],
        },
      ],
    });
    const git = fakeGit();
    const manager = new WorktreeManager(jailed, git);
    const claimed = await manager.claim("repo-1", "wt-1");
    manager.setAllowedRootsPolicy([]);
    await expect(manager.prepareCheckout(claimed, undefined)).rejects.toThrow(
      "host inventory changed after this checkout was claimed",
    );
    expect(git.checkoutRef).not.toHaveBeenCalled();
  });

  it("uses canonical paths for startup Git preparation", async () => {
    const root = join(tmpdir(), `ah-canonical-ensure-${String(Date.now())}`);
    fixtures.push(root);
    const repository = join(root, "repository");
    const worktree = join(repository, "worktree");
    await mkdir(worktree, { recursive: true });
    const repositoryLink = join(root, "repository-link");
    const worktreeLink = join(root, "worktree-link");
    await symlink(repository, repositoryLink);
    await symlink(worktree, worktreeLink);
    const jailed = parseDaemonConfig({
      hostId: "a1",
      allowedRoots: [root],
      repositories: [
        {
          id: "repo-1",
          path: repositoryLink,
          defaultBranch: "main",
          worktrees: [{ id: "wt-1", name: "wt-1", path: worktreeLink, labels: [] }],
        },
      ],
    });
    const git = fakeGit();
    await new WorktreeManager(jailed, git).ensureAll();
    expect(git.ensureRepo).toHaveBeenCalledWith(await realpath(repository));
    expect(git.ensureWorktree).toHaveBeenCalledWith({
      repoPath: await realpath(repository),
      worktreePath: await realpath(worktree),
      branch: "main",
    });
  });

  it("retries a claim against the refreshed inventory after async validation", async () => {
    const root = join(tmpdir(), `ah-claim-refresh-${String(Date.now())}`);
    fixtures.push(root);
    const oldWorktree = join(root, "old", "wt");
    const newWorktree = join(root, "new", "wt");
    await mkdir(oldWorktree, { recursive: true });
    await mkdir(newWorktree, { recursive: true });
    const refreshConfig = parseDaemonConfig({
      hostId: "a1",
      allowedRoots: [root],
      repositories: [
        {
          id: "repo-1",
          path: join(root, "old"),
          defaultBranch: "main",
          worktrees: [{ id: "wt-1", name: "wt-1", path: oldWorktree, labels: [] }],
        },
      ],
    });
    const manager = new WorktreeManager(refreshConfig, fakeGit());
    const pending = manager.claim("repo-1", "wt-1");
    refreshConfig.repositories = [
      {
        id: "repo-1",
        path: join(root, "new"),
        defaultBranch: "main",
        worktrees: [{ id: "wt-1", name: "wt-1", path: newWorktree, labels: [] }],
      },
    ];
    manager.noteInventoryChange();
    await expect(pending).resolves.toMatchObject({ cwd: await realpath(newWorktree) });
  });
});
