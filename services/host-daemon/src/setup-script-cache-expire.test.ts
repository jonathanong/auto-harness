import { chmod, mkdir, mkdtemp, readdir, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import type { DaemonConfig } from "./config-types.ts";
import { expireOrphanedSetupCache, liveSetupCacheFileNames } from "./setup-script-cache-expire.ts";
import { setupCacheFileName, writeStoredSetupCache } from "./setup-script-cache.ts";

function inventory(worktrees: Array<{ id: string; path: string }>): DaemonConfig {
  return {
    hostId: "h",
    repositories: [
      {
        id: "repo-1",
        path: "/repo",
        defaultBranch: "main",
        worktrees: worktrees.map((worktree) => ({
          ...worktree,
          name: worktree.id,
          labels: [],
        })),
      },
    ],
    providerAccounts: [],
  };
}

describe("setup-script cache expiry", () => {
  it("keeps live worktree, main-checkout, and workspace slot names", () => {
    const names = liveSetupCacheFileNames({
      hostId: "h",
      repositories: [
        {
          id: "repo-1",
          path: "/tmp/repo/../repo",
          defaultBranch: "main",
          worktrees: [{ id: "wt-1", name: "wt-1", path: "/tmp/wt/../wt", labels: [] }],
        },
      ],
      workspacePools: [
        { workspacePoolId: "pool", slots: [{ id: "slot", name: "slot", path: "/ws/slot" }] },
      ],
      providerAccounts: [],
    });
    expect(names.has(setupCacheFileName("wt-1", "/tmp/wt/../wt"))).toBe(true);
    expect(names.has(setupCacheFileName("wt-1", resolve("/tmp/wt/../wt")))).toBe(true);
    expect(names.has(setupCacheFileName("main:repo-1", "/tmp/repo/../repo"))).toBe(true);
    expect(names.has(setupCacheFileName("slot", "/ws/slot"))).toBe(true);
  });

  it("deletes a removed worktree sidecar and keeps a live one", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "ah-setup-cache-expire-"));
    const livePath = join(cacheDir, "live");
    const gonePath = join(cacheDir, "gone");
    await writeStoredSetupCache(cacheDir, "wt-live", livePath, "fp", { A: "1" });
    await writeStoredSetupCache(cacheDir, "wt-gone", gonePath, "fp", { B: "2" });
    await expireOrphanedSetupCache(cacheDir, {
      ...inventory([{ id: "wt-live", path: livePath }]),
      workspacePools: [
        {
          workspacePoolId: "pool",
          slots: [{ id: "slot", name: "slot", path: join(cacheDir, "missing-slot") }],
        },
      ],
    });
    expect(await readdir(cacheDir)).toEqual([setupCacheFileName("wt-live", livePath)]);
  });

  it("deletes the old path when a worktree is relocated", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "ah-setup-cache-move-"));
    const oldPath = join(cacheDir, "old");
    const newPath = join(cacheDir, "new");
    await writeStoredSetupCache(cacheDir, "wt-1", oldPath, "fp", { A: "1" });
    await writeStoredSetupCache(cacheDir, "wt-1", newPath, "fp", { A: "1" });
    await expireOrphanedSetupCache(cacheDir, inventory([{ id: "wt-1", path: newPath }]));
    expect(await readdir(cacheDir)).toEqual([setupCacheFileName("wt-1", newPath)]);
  });

  it("keeps a sidecar keyed by the resolved checkout path", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "ah-setup-cache-realpath-"));
    const cacheDir = await mkdtemp(join(tmpdir(), "ah-setup-cache-realpath-store-"));
    const real = join(root, "real");
    await mkdir(real);
    const link = join(root, "link");
    await symlink(real, link);
    const resolved = await realpath(link);
    await writeStoredSetupCache(cacheDir, "wt-1", resolved, "fp", { A: "1" });
    await expireOrphanedSetupCache(cacheDir, inventory([{ id: "wt-1", path: link }]));
    expect(await readdir(cacheDir)).toEqual([setupCacheFileName("wt-1", resolved)]);
  });

  it("ignores a missing cache directory, stray names, and unlink errors", async () => {
    await expireOrphanedSetupCache(join(tmpdir(), "ah-setup-cache-missing-nope"), inventory([]));
    const cacheDir = await mkdtemp(join(tmpdir(), "ah-setup-cache-sweep-"));
    await writeFile(join(cacheDir, "readme.txt"), "keep");
    await mkdir(join(cacheDir, "a".repeat(64)));
    await writeFile(join(cacheDir, "b".repeat(64)), "orphan");
    await expireOrphanedSetupCache(join(cacheDir, "readme.txt"), inventory([]));
    if (process.platform !== "win32") {
      await chmod(cacheDir, 0o555);
      await expireOrphanedSetupCache(cacheDir, inventory([]));
      await chmod(cacheDir, 0o755);
    }
    await expireOrphanedSetupCache(cacheDir, inventory([]), {});
    expect((await readdir(cacheDir)).toSorted()).toEqual(["a".repeat(64), "readme.txt"]);
  });

  it("bounds how many orphan sidecars one sweep unlinks", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "ah-setup-cache-bound-"));
    for (const id of ["a", "b", "c"]) {
      await writeStoredSetupCache(cacheDir, id, join(cacheDir, id), "fp", {});
    }
    await expireOrphanedSetupCache(cacheDir, inventory([]), { maxUnlinks: 2 });
    expect((await readdir(cacheDir)).length).toBe(1);
    await expireOrphanedSetupCache(cacheDir, inventory([]), { maxUnlinks: 2 });
    expect(await readdir(cacheDir)).toEqual([]);
  });
});
