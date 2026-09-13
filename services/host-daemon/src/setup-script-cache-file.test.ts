import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  MAX_SETUP_CACHE_INPUT_BYTES,
  readBoundedRegularFile,
  readDeclaredSetupFiles,
} from "./setup-script-cache-file.ts";
import { resolveSetupCacheState } from "./setup-script-cache.ts";

describe("declared setup cache extra files", () => {
  it("treats an oversized declared extra as a cache miss without reading it", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "auto-harness-setup-cache-oversize-"));
    const extra = join(cwd, "pnpm-lock.yaml");
    await writeFile(extra, "");
    await truncate(extra, MAX_SETUP_CACHE_INPUT_BYTES + 1);
    expect(await readDeclaredSetupFiles(cwd, ["pnpm-lock.yaml"])).toBeUndefined();
    await writeFile(join(cwd, "empty.lock"), "");
    expect(await readDeclaredSetupFiles(cwd, ["empty.lock"])).toEqual([
      { path: "empty.lock", contents: Buffer.from("") },
    ]);
    expect(await readDeclaredSetupFiles(cwd, ["../secret"])).toBeUndefined();
    const cache = await resolveSetupCacheState({
      cacheDir: cwd,
      checkoutSha: "abc",
      cwd,
      worktreeId: "wt-1",
      scripts: ["pnpm install"],
      extraPaths: ["pnpm-lock.yaml"],
    });
    expect(cache.skip).toBe(false);
  });

  it("treats a FIFO or symlink-to-nonfile as a cache miss", async () => {
    if (process.platform === "win32") return;
    const cwd = await mkdtemp(join(tmpdir(), "auto-harness-setup-cache-special-"));
    execFileSync("mkfifo", [join(cwd, "fifo.lock")], { stdio: "ignore" });
    expect(await readDeclaredSetupFiles(cwd, ["fifo.lock"])).toBeUndefined();
    await symlink("/dev/null", join(cwd, "device.lock"));
    expect(await readDeclaredSetupFiles(cwd, ["device.lock"])).toBeUndefined();
    await mkdir(join(cwd, "dir.lock"));
    expect(await readDeclaredSetupFiles(cwd, ["dir.lock"])).toBeUndefined();
  });

  it("does not skip when the session abort fires during a declared-file read", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "auto-harness-setup-cache-abort-"));
    const extra = join(cwd, "pnpm-lock.yaml");
    await writeFile(extra, "x".repeat(128 * 1024));
    expect(await readBoundedRegularFile(extra, AbortSignal.abort())).toBeUndefined();
    expect(
      await readDeclaredSetupFiles(cwd, ["pnpm-lock.yaml"], AbortSignal.abort()),
    ).toBeUndefined();
    let afterOpen = 0;
    expect(
      await readBoundedRegularFile(extra, {
        get aborted() {
          afterOpen += 1;
          return afterOpen > 1;
        },
      } as AbortSignal),
    ).toBeUndefined();
    let duringRead = 0;
    expect(
      await readBoundedRegularFile(extra, {
        get aborted() {
          duringRead += 1;
          return duringRead > 2;
        },
      } as AbortSignal),
    ).toBeUndefined();
    const cache = await resolveSetupCacheState({
      cacheDir: cwd,
      checkoutSha: "abc",
      cwd,
      worktreeId: "wt-1",
      scripts: ["pnpm install"],
      extraPaths: ["pnpm-lock.yaml"],
      signal: AbortSignal.abort(),
    });
    expect(cache.skip).toBe(false);
  });

  it("does not skip without a cache directory or checkout sha", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "auto-harness-setup-cache-sha-"));
    expect(
      await resolveSetupCacheState({
        cacheDir: undefined,
        checkoutSha: "abc",
        cwd,
        worktreeId: "wt-1",
        scripts: ["true"],
        extraPaths: [],
      }),
    ).toEqual({ skip: false });
    expect(
      await resolveSetupCacheState({
        cacheDir: cwd,
        checkoutSha: undefined,
        cwd,
        worktreeId: "wt-1",
        scripts: ["true"],
        extraPaths: [],
      }),
    ).toEqual({ skip: false });
  });
});
