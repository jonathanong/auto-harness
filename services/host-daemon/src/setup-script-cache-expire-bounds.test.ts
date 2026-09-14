import { chmod, mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { DaemonConfig } from "./config-types.ts";
import { expireOrphanedSetupCache } from "./setup-script-cache-expire.ts";
import { writeStoredSetupCache } from "./setup-script-cache.ts";

function inventory(): DaemonConfig {
  return {
    hostId: "h",
    repositories: [
      {
        id: "repo-1",
        path: "/repo",
        defaultBranch: "main",
        worktrees: [],
      },
    ],
    providerAccounts: [],
  };
}

async function writeOrphans(cacheDir: string, ids: string[]): Promise<void> {
  for (const id of ids) {
    await writeStoredSetupCache(cacheDir, id, join(cacheDir, id), "fp", {});
  }
}

describe("setup-script cache expiry bounds", () => {
  it("counts unlink attempts including failures toward the cap", async () => {
    if (process.platform === "win32") return;
    const cacheDir = await mkdtemp(join(tmpdir(), "ah-setup-cache-attempt-"));
    await writeOrphans(cacheDir, ["a", "b", "c"]);
    await chmod(cacheDir, 0o555);
    const result = await expireOrphanedSetupCache(cacheDir, inventory(), {
      maxUnlinks: 2,
      maxEntries: 100,
    });
    await chmod(cacheDir, 0o755);
    expect(result).toEqual({ more: true });
    expect((await readdir(cacheDir)).length).toBe(3);
  });

  it("streams with opendir and does not materialize past the examine cap", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "ah-setup-cache-examine-"));
    await writeOrphans(cacheDir, ["a", "b", "c", "d", "e"]);
    expect(
      await expireOrphanedSetupCache(cacheDir, inventory(), { maxUnlinks: 100, maxEntries: 2 }),
    ).toEqual({ more: true });
    expect((await readdir(cacheDir)).length).toBeGreaterThanOrEqual(3);
  });

  it("reports no leftover when a cap lands on end-of-directory", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "ah-setup-cache-exact-"));
    await writeOrphans(cacheDir, ["a", "b"]);
    expect(
      await expireOrphanedSetupCache(cacheDir, inventory(), { maxUnlinks: 2, maxEntries: 2 }),
    ).toEqual({ more: false });
    expect(await readdir(cacheDir)).toEqual([]);
  });

  it("ignores non-sidecar names without counting them as unlink attempts", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "ah-setup-cache-skip-"));
    await writeFile(join(cacheDir, "readme.txt"), "keep");
    await mkdir(join(cacheDir, "a".repeat(64)));
    await writeOrphans(cacheDir, ["only"]);
    expect(
      await expireOrphanedSetupCache(cacheDir, inventory(), { maxUnlinks: 2, maxEntries: 100 }),
    ).toEqual({ more: false });
    expect((await readdir(cacheDir)).toSorted()).toEqual(["a".repeat(64), "readme.txt"]);
  });
});
