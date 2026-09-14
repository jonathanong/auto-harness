import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  invalidateStoredSetupCache,
  resolveSetupCacheState,
  writeStoredSetupCache,
} from "./setup-script-cache.ts";

describe("invalidateStoredSetupCache", () => {
  it("drops a stored fingerprint so matching inputs miss after ignored outputs change", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "auto-harness-setup-cache-invalidate-cwd-"));
    const cacheDir = await mkdtemp(join(tmpdir(), "auto-harness-setup-cache-invalidate-"));
    await writeFile(join(cwd, "pnpm-lock.yaml"), "lock-a");
    const first = await resolveSetupCacheState({
      cacheDir,
      checkoutSha: "abc",
      cwd,
      worktreeId: "wt-1",
      scripts: ["pnpm install"],
      extraPaths: ["pnpm-lock.yaml"],
    });
    if (first.skip || !first.fingerprintToStore) throw new Error("expected a fingerprint");
    await writeStoredSetupCache(cacheDir, "wt-1", cwd, first.fingerprintToStore, { TOKEN: "x" });
    await mkdir(join(cwd, "node_modules"), { recursive: true });
    await writeFile(join(cwd, "node_modules/left-over"), "mutated");
    await invalidateStoredSetupCache(cacheDir, "wt-1", cwd);
    const after = await resolveSetupCacheState({
      cacheDir,
      checkoutSha: "abc",
      cwd,
      worktreeId: "wt-1",
      scripts: ["pnpm install"],
      extraPaths: ["pnpm-lock.yaml"],
    });
    expect(after.skip).toBe(false);
    expect(after).toMatchObject({ fingerprintToStore: first.fingerprintToStore });
  });

  it("ignores a missing sidecar or omitted cache directory", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "auto-harness-setup-cache-invalidate-missing-"));
    await expect(invalidateStoredSetupCache(undefined, "wt-1", cwd)).resolves.toBeUndefined();
    await expect(
      invalidateStoredSetupCache(
        await mkdtemp(join(tmpdir(), "auto-harness-setup-cache-invalidate-empty-")),
        "wt-1",
        cwd,
      ),
    ).resolves.toBeUndefined();
  });
});
