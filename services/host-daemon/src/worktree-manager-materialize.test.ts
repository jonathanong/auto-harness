/* eslint-disable max-lines -- pending-checkout scenarios share one fake git. */
import { describe, expect, it, vi } from "vitest";

import { parseDaemonConfig } from "./config.ts";
import type { GitClient } from "./git.ts";
import { WorktreeManager } from "./worktree-manager.ts";

const config = parseDaemonConfig({
  hostId: "a1",
  repositories: [
    {
      id: "repo-1",
      path: "/repo",
      defaultBranch: "main",
      worktrees: [
        { id: "wt-1", name: "wt-1", path: "/repo/wt-1", labels: [] },
        { id: "wt-2", name: "wt-2", path: "/repo/wt-2", labels: [] },
      ],
    },
    {
      id: "repo-2",
      path: "/repo2",
      defaultBranch: "main",
      worktrees: [{ id: "wt-3", name: "wt-3", path: "/repo2/wt-3", labels: [] }],
    },
  ],
});

/** Stands in for the git CLI boundary: `onDisk` is what `git worktree list` would report. */
function fakeGit(onDisk: Set<string>, failing = new Set<string>()) {
  const created: string[] = [];
  const git: GitClient = {
    ensureRepo: vi.fn(async () => undefined),
    ensureWorktree: vi.fn(async ({ worktreePath, createMissing = true }) => {
      if (onDisk.has(worktreePath)) return;
      if (!createMissing) return "missing";
      if (failing.has(worktreePath))
        throw new Error(`Failed to create worktree at ${worktreePath}`);
      onDisk.add(worktreePath);
      created.push(worktreePath);
    }),
    checkoutRef: vi.fn(async () => undefined),
    prepareMainCheckout: vi.fn(async () => undefined),
    revParse: vi.fn(async () => "abc"),
  };
  return { git, created };
}

const wt = (id: string, path: string) => ({ id, name: id, path, labels: [] });

describe("WorktreeManager materialization", () => {
  it("adopts the inventory without creating checkouts and withholds missing ones", async () => {
    const { git, created } = fakeGit(new Set(["/repo/wt-1"]));
    const manager = new WorktreeManager(config, git);
    await manager.ensureAll();

    expect(created).toEqual([]);
    expect(manager.isMaterialized("repo-1", wt("wt-1", "/repo/wt-1"))).toBe(true);
    expect(manager.isMaterialized("repo-1", wt("wt-2", "/repo/wt-2"))).toBe(false);
    expect(manager.hasAssignmentTarget("repo-1", "wt-1")).toBe(true);
    expect(manager.hasAssignmentTarget("repo-1", "wt-2")).toBe(false);
    expect(manager.hasAssignmentTarget("repo-2", "wt-3")).toBe(false);
    expect(manager.hasAssignmentTarget("repo-1", null)).toBe(true);
    expect(manager.isPendingTarget("repo-1", "wt-2")).toBe(true);
    expect(manager.isPendingTarget("repo-1", "wt-1")).toBe(false);
    expect(manager.isPendingTarget("repo-1", null)).toBe(false);
    expect(manager.isPendingTarget("nope", "wt-2")).toBe(false);
    await expect(manager.claim("repo-1", "wt-2")).rejects.toThrow("Worktree not ready: wt-2");
    expect(manager.isBusy("wt-2")).toBe(false);
    await expect(manager.claim("repo-1", "wt-1")).resolves.toMatchObject({ cwd: "/repo/wt-1" });
  });

  it("creates pending checkouts one at a time and reports each as ready", async () => {
    const { git, created } = fakeGit(new Set());
    const manager = new WorktreeManager(config, git);
    await manager.ensureAll();
    const ready = vi.fn();
    await manager.materializePending({ onReady: ready });

    expect(created).toEqual(["/repo/wt-1", "/repo/wt-2", "/repo2/wt-3"]);
    expect(ready).toHaveBeenCalledTimes(3);
    expect(manager.hasAssignmentTarget("repo-2", "wt-3")).toBe(true);
    await manager.materializePending({ onReady: ready });
    expect(ready).toHaveBeenCalledTimes(3);
  });

  it("is single-flight", async () => {
    const { git } = fakeGit(new Set());
    const manager = new WorktreeManager(config, git);
    await manager.ensureAll();
    const first = manager.materializePending();
    expect(manager.materializePending()).toBe(first);
    await first;
  });

  it("keeps materializing the rest when one checkout fails, and backs off that one", async () => {
    const onDisk = new Set<string>();
    const failing = new Set(["/repo/wt-1"]);
    const { git, created } = fakeGit(onDisk, failing);
    const manager = new WorktreeManager(config, git);
    await manager.ensureAll();
    let clock = 1_000;
    const errors: string[] = [];
    const hooks = { now: () => clock, onError: (message: string) => errors.push(message) };

    await manager.materializePending(hooks);
    expect(created).toEqual(["/repo/wt-2", "/repo2/wt-3"]);
    expect(errors).toEqual([expect.stringContaining("/repo/wt-1 not ready")]);
    expect(manager.hasAssignmentTarget("repo-1", "wt-1")).toBe(false);
    expect(manager.hasAssignmentTarget("repo-1", "wt-2")).toBe(true);

    // Still inside the backoff window: not retried.
    clock += 1_000;
    await manager.materializePending(hooks);
    expect(errors).toHaveLength(1);

    // The window elapses and the next attempt, now succeeding, makes it assignable.
    failing.clear();
    clock += 60_000;
    await manager.materializePending(hooks);
    expect(created).toContain("/repo/wt-1");
    expect(manager.hasAssignmentTarget("repo-1", "wt-1")).toBe(true);
  });

  it("grows the backoff with repeated failures up to a cap", async () => {
    const { git } = fakeGit(new Set(["/repo/wt-2", "/repo2/wt-3"]), new Set(["/repo/wt-1"]));
    const manager = new WorktreeManager(config, git);
    await manager.ensureAll();
    let clock = 0;
    const errors: string[] = [];
    const hooks = { now: () => clock, onError: (message: string) => errors.push(message) };
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await manager.materializePending(hooks);
      clock += 6 * 60_000;
    }
    expect(errors).toHaveLength(12);
  });

  it("stops when aborted and does not count an abort as a failure", async () => {
    const controller = new AbortController();
    const onDisk = new Set<string>();
    const { git } = fakeGit(onDisk);
    const ensure = git.ensureWorktree as ReturnType<typeof vi.fn>;
    const original = ensure.getMockImplementation()!;
    ensure.mockImplementation(async (opts) => {
      if (opts.createMissing === false) return original(opts);
      controller.abort();
      throw new Error("aborted");
    });
    const manager = new WorktreeManager(config, git);
    await manager.ensureAll();
    const onError = vi.fn();
    await manager.materializePending({ signal: controller.signal, onError });
    expect(onError).not.toHaveBeenCalled();
    expect(ensure).toHaveBeenCalledTimes(
      config.repositories.flatMap((r) => r.worktrees).length + 1,
    );
    await manager.materializePending({ signal: controller.signal });
    expect(manager.hasAssignmentTarget("repo-1", "wt-1")).toBe(false);
  });

  it("stringifies non-Error failures", async () => {
    const { git } = fakeGit(new Set());
    const ensure = git.ensureWorktree as ReturnType<typeof vi.fn>;
    const original = ensure.getMockImplementation()!;
    ensure.mockImplementation(async (opts) => {
      if (opts.createMissing === false) return original(opts);
      throw "disk full";
    });
    const manager = new WorktreeManager(config, git);
    await manager.ensureAll();
    const errors: string[] = [];
    await manager.materializePending({ onError: (message) => errors.push(message) });
    expect(errors[0]).toContain("disk full");
  });

  it("retains backoff state across an unchanged re-adoption and drops removed worktrees", async () => {
    const { git } = fakeGit(new Set(), new Set(["/repo/wt-1"]));
    const manager = new WorktreeManager(config, git);
    await manager.ensureAll();
    let clock = 0;
    const errors: string[] = [];
    const hooks = { now: () => clock, onError: (message: string) => errors.push(message) };
    await manager.materializePending(hooks);
    await manager.ensureAll(config);
    await manager.materializePending(hooks);
    expect(errors.filter((message) => message.includes("/repo/wt-1"))).toHaveLength(1);

    await manager.ensureAll(
      parseDaemonConfig({
        hostId: "a1",
        repositories: [{ id: "repo-1", path: "/repo", defaultBranch: "main", worktrees: [] }],
      }),
    );
    expect(manager.isMaterialized("repo-1", wt("wt-1", "/repo/wt-1"))).toBe(true);
  });

  it("keeps an in-flight entry through an unchanged re-adoption but refreshes a changed one", async () => {
    const onDisk = new Set<string>();
    const { git } = fakeGit(onDisk);
    const manager = new WorktreeManager(config, git);
    await manager.ensureAll();
    const ensure = git.ensureWorktree as ReturnType<typeof vi.fn>;
    const original = ensure.getMockImplementation()!;
    let ready = 0;
    ensure.mockImplementation(async (opts) => {
      if (opts.worktreePath === "/repo/wt-1" && opts.createMissing !== false) {
        // The same inventory is adopted again while this checkout is being created.
        await manager.ensureAll(config);
      }
      return original(opts);
    });
    await manager.materializePending({ onReady: () => void ready++ });
    expect(ready).toBeGreaterThan(0);

    // A changed branch is a new target: it replaces the entry and keeps only the failure count.
    const changed = parseDaemonConfig({
      hostId: "a1",
      repositories: [
        {
          id: "repo-1",
          path: "/repo",
          defaultBranch: "develop",
          worktrees: [wt("wt-9", "/repo/wt-9")],
        },
      ],
    });
    await manager.ensureAll(changed);
    expect(manager.isMaterialized("repo-1", wt("wt-9", "/repo/wt-9"))).toBe(false);
    const snapshot = manager.snapshotPending();
    await manager.ensureAll(config);
    manager.restorePending(snapshot);
    expect(manager.isMaterialized("repo-1", wt("wt-9", "/repo/wt-9"))).toBe(false);
  });

  it("rechecks readiness when a refresh moves the claimed worktree to a pending path", async () => {
    const { git } = fakeGit(new Set(["/repo/wt-1", "/repo/wt-2", "/repo2/wt-3"]));
    const manager = new WorktreeManager(config, git);
    await manager.ensureAll();
    const moved = parseDaemonConfig({
      hostId: "a1",
      repositories: [
        {
          id: "repo-1",
          path: "/repo",
          defaultBranch: "main",
          worktrees: [wt("wt-1", "/repo/wt-1-moved")],
        },
      ],
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const internals = manager as unknown as {
      config: unknown;
      assertClaimPaths: () => Promise<unknown>;
    };
    internals.assertClaimPaths = async () => {
      await gate;
      return { cwd: "/repo/wt-1", repositoryPath: "/repo" };
    };
    const claim = manager.claim("repo-1", "wt-1");
    // The refresh lands while the claim is validating paths.
    await manager.ensureAll(moved);
    internals.config = moved;
    manager.noteInventoryChange();
    release();
    await expect(claim).rejects.toThrow("Worktree not ready: wt-1");
  });

  it("skips an entry that was replaced by a newer inventory while it waited", async () => {
    const { git, created } = fakeGit(new Set());
    const manager = new WorktreeManager(config, git);
    await manager.ensureAll();
    const ensure = git.ensureWorktree as ReturnType<typeof vi.fn>;
    const original = ensure.getMockImplementation()!;
    ensure.mockImplementation(async (opts) => {
      const result = await original(opts);
      if (opts.worktreePath === "/repo/wt-1" && opts.createMissing !== false) {
        // The operator removes wt-2 while wt-1 is still being created.
        await manager.ensureAll(
          parseDaemonConfig({
            hostId: "a1",
            repositories: [
              {
                id: "repo-1",
                path: "/repo",
                defaultBranch: "main",
                worktrees: [{ id: "wt-1", name: "wt-1", path: "/repo/wt-1", labels: [] }],
              },
            ],
          }),
        );
      }
      return result;
    });
    await manager.materializePending();
    expect(created).toEqual(["/repo/wt-1"]);
  });
});
