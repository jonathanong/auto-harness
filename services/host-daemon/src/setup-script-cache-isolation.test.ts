import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  readStoredSetupCache,
  resolveSetupCacheState,
  setupCacheFileName,
  writeStoredSetupCache,
} from "./setup-script-cache.ts";

async function storeDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "ah-setup-cache-isolation-"));
}

async function runAsSessionCommand(script: string): Promise<void> {
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    env: { PATH: process.env.PATH },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const [code] = (await once(child, "close")) as [number | null];
  if (code !== 0) throw new Error(stderr || `session command exited ${String(code)}`);
}

describe("setup-cache sidecar isolation", () => {
  it("does not let a copied sidecar become a hit for another worktree", async () => {
    const cacheDir = await storeDir();
    await writeStoredSetupCache(cacheDir, "wt-a", "/wt/a", "fp-a", { TOKEN: "a" });
    await writeStoredSetupCache(cacheDir, "wt-b", "/wt/b", "fp-b", { TOKEN: "b" });
    const fromA = join(cacheDir, setupCacheFileName("wt-a", "/wt/a"));
    const toB = join(cacheDir, setupCacheFileName("wt-b", "/wt/b"));
    await writeFile(toB, await readFile(fromA));
    expect(await readStoredSetupCache(cacheDir, "wt-a", "/wt/a")).toEqual({
      fingerprint: "fp-a",
      environment: { TOKEN: "a" },
    });
    expect(await readStoredSetupCache(cacheDir, "wt-b", "/wt/b")).toBeUndefined();
  });

  it("ignores a session command that writes the public worktree hash", async () => {
    const cacheDir = await storeDir();
    await writeStoredSetupCache(cacheDir, "wt-a", "/wt/a", "fp-a", { TOKEN: "from-a" });
    const guessed = JSON.stringify("wt-a\0/wt/a");
    const poison = JSON.stringify({ fingerprint: "fp-a", environment: { TOKEN: "pwned" } });
    await runAsSessionCommand(`
      import { createHash } from "node:crypto";
      import { writeFile } from "node:fs/promises";
      import { join } from "node:path";
      const guessed = createHash("sha256").update(${guessed}).digest("hex");
      await writeFile(join(${JSON.stringify(cacheDir)}, guessed), ${JSON.stringify(poison)});
    `);
    expect(await readStoredSetupCache(cacheDir, "wt-a", "/wt/a")).toEqual({
      fingerprint: "fp-a",
      environment: { TOKEN: "from-a" },
    });
  });

  it("treats a session overwrite of another worktree's sidecar as a miss", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "ah-setup-cache-isolation-cwd-"));
    await writeFile(join(cwd, "lock"), "a");
    const cacheDir = await storeDir();
    await writeStoredSetupCache(cacheDir, "wt-a", cwd, "fp-a", { TOKEN: "from-a" });
    await writeStoredSetupCache(cacheDir, "wt-b", "/wt/b", "fp-b", { TOKEN: "from-b" });
    const poison = JSON.stringify({ fingerprint: "fp-a", environment: { TOKEN: "pwned" } });
    await runAsSessionCommand(`
      import { readdir, writeFile } from "node:fs/promises";
      import { join } from "node:path";
      const cacheDir = ${JSON.stringify(cacheDir)};
      const poison = ${JSON.stringify(poison)};
      for (const name of await readdir(cacheDir)) {
        await writeFile(join(cacheDir, name), poison);
      }
    `);
    expect(await readStoredSetupCache(cacheDir, "wt-a", cwd)).toBeUndefined();
    expect(await readStoredSetupCache(cacheDir, "wt-b", "/wt/b")).toBeUndefined();
    const missed = await resolveSetupCacheState({
      cacheDir,
      checkoutSha: "abc",
      cwd,
      worktreeId: "wt-a",
      scripts: ["true"],
      extraPaths: ["lock"],
    });
    expect(missed.skip).toBe(false);
  });

  it("does not follow a planted symlink to another worktree's sidecar", async () => {
    if (process.platform === "win32") return;
    const cacheDir = await storeDir();
    await writeStoredSetupCache(cacheDir, "wt-a", "/wt/a", "fp-a", { TOKEN: "a" });
    const pathB = join(cacheDir, setupCacheFileName("wt-b", "/wt/b"));
    await symlink(join(cacheDir, setupCacheFileName("wt-a", "/wt/a")), pathB);
    expect(await readStoredSetupCache(cacheDir, "wt-b", "/wt/b")).toBeUndefined();
    expect(await readStoredSetupCache(cacheDir, "wt-a", "/wt/a")).toEqual({
      fingerprint: "fp-a",
      environment: { TOKEN: "a" },
    });
  });

  it("treats unsigned or invalid-MAC sidecars as misses", async () => {
    const cacheDir = await storeDir();
    const cwd = "/wt/a";
    await writeStoredSetupCache(cacheDir, "wt-a", cwd, "fp-a", { TOKEN: "a" });
    const sidecar = join(cacheDir, setupCacheFileName("wt-a", cwd));
    await writeFile(sidecar, JSON.stringify({ fingerprint: "fp-a", environment: { TOKEN: "a" } }));
    expect(await readStoredSetupCache(cacheDir, "wt-a", cwd)).toBeUndefined();
    await writeFile(
      sidecar,
      JSON.stringify({ fingerprint: "fp-a", environment: { TOKEN: "a" }, mac: 1 }),
    );
    expect(await readStoredSetupCache(cacheDir, "wt-a", cwd)).toBeUndefined();
    await writeFile(
      sidecar,
      JSON.stringify({ fingerprint: "fp-a", environment: { TOKEN: "a" }, mac: "0".repeat(64) }),
    );
    expect(await readStoredSetupCache(cacheDir, "wt-a", cwd)).toBeUndefined();
  });

  it("fails closed when the sidecar path is a directory and leaves other worktrees intact", async () => {
    const cacheDir = await storeDir();
    await writeStoredSetupCache(cacheDir, "wt-a", "/wt/a", "fp-a", { TOKEN: "a" });
    await mkdir(join(cacheDir, setupCacheFileName("wt-b", "/wt/b")));
    await expect(
      writeStoredSetupCache(cacheDir, "wt-b", "/wt/b", "fp-b", { TOKEN: "b" }),
    ).rejects.toThrow();
    expect(await readStoredSetupCache(cacheDir, "wt-a", "/wt/a")).toEqual({
      fingerprint: "fp-a",
      environment: { TOKEN: "a" },
    });
    expect(await readStoredSetupCache(cacheDir, "wt-b", "/wt/b")).toBeUndefined();
  });

  it("does not write through a non-directory cache path", async () => {
    const parent = await storeDir();
    await writeStoredSetupCache(parent, "wt-a", "/wt/a", "fp-a", { TOKEN: "a" });
    const cacheDir = join(parent, "not-dir");
    await writeFile(cacheDir, "file");
    await expect(
      writeStoredSetupCache(cacheDir, "wt-b", "/wt/b", "fp-b", { TOKEN: "b" }),
    ).rejects.toThrow();
    expect(await readStoredSetupCache(parent, "wt-a", "/wt/a")).toEqual({
      fingerprint: "fp-a",
      environment: { TOKEN: "a" },
    });
  });
});
