import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  defaultSetupCacheDir,
  fingerprintSetup,
  mergeSetupCacheInputs,
  readDeclaredSetupFiles,
  readStoredSetupCache,
  sanitizeCapturedSetupEnvironment,
  setupCacheFileName,
  writeStoredSetupCache,
} from "./setup-script-cache.ts";

describe("setup script fingerprint", () => {
  it("changes when the ref, script, or a declared extra file changes", () => {
    const base = fingerprintSetup({
      checkoutSha: "abc",
      scripts: ["pnpm install"],
      extraFiles: [{ path: "pnpm-lock.yaml", contents: Buffer.from("lock-a") }],
    });
    expect(
      fingerprintSetup({
        checkoutSha: "def",
        scripts: ["pnpm install"],
        extraFiles: [{ path: "pnpm-lock.yaml", contents: Buffer.from("lock-a") }],
      }),
    ).not.toBe(base);
    expect(
      fingerprintSetup({
        checkoutSha: "abc",
        scripts: ["pnpm install --frozen-lockfile"],
        extraFiles: [{ path: "pnpm-lock.yaml", contents: Buffer.from("lock-a") }],
      }),
    ).not.toBe(base);
    expect(
      fingerprintSetup({
        checkoutSha: "abc",
        scripts: ["pnpm install"],
        extraFiles: [{ path: "pnpm-lock.yaml", contents: Buffer.from("lock-b") }],
      }),
    ).not.toBe(base);
  });

  it("does not hash undeclared lockfiles", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "auto-harness-setup-cache-files-"));
    await writeFile(join(cwd, "pnpm-lock.yaml"), "declared");
    await writeFile(join(cwd, "package.json"), "undeclared");
    const extras = await readDeclaredSetupFiles(cwd, ["pnpm-lock.yaml"]);
    expect(extras).toEqual([{ path: "pnpm-lock.yaml", contents: Buffer.from("declared") }]);
    await writeFile(join(cwd, "package.json"), "changed");
    expect(await readDeclaredSetupFiles(cwd, ["pnpm-lock.yaml"])).toEqual(extras);
  });

  it("treats a missing declared extra as a cache miss", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "auto-harness-setup-cache-missing-"));
    expect(await readDeclaredSetupFiles(cwd, ["pnpm-lock.yaml"])).toBeUndefined();
  });

  it("persists fingerprint and environment outside the checkout", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "auto-harness-setup-cache-dir-"));
    const cwd = await mkdir(join(cacheDir, "checkout"), { recursive: true });
    await writeStoredSetupCache(cacheDir, "wt-1", cwd, "abc", {
      SETUP_TOKEN: "from-setup",
      HARNESS_API_KEY: "secret",
      UNSET: undefined,
    });
    expect(await readStoredSetupCache(cacheDir, "wt-1", cwd)).toEqual({
      fingerprint: "abc",
      environment: { SETUP_TOKEN: "from-setup" },
    });
    const sidecar = join(cacheDir, setupCacheFileName("wt-1", cwd));
    expect((await stat(sidecar)).mode & 0o777).toBe(0o600);
    expect(await readFile(sidecar, "utf8")).not.toContain("secret");
    expect(await readFile(join(cwd, "abc"), "utf8").catch(() => "missing")).toBe("missing");
    expect(sanitizeCapturedSetupEnvironment(["nope"])).toBeUndefined();
    expect(sanitizeCapturedSetupEnvironment(null)).toBeUndefined();
    expect(sanitizeCapturedSetupEnvironment({ HARNESS_X: "y", OK: "z", n: 1 })).toEqual({
      OK: "z",
    });
    expect(await readStoredSetupCache(cacheDir, "wt-1", join(cwd, "missing"))).toBeUndefined();
    await writeFile(sidecar, JSON.stringify(["abc"]));
    expect(await readStoredSetupCache(cacheDir, "wt-1", cwd)).toBeUndefined();
    await writeFile(sidecar, JSON.stringify({ fingerprint: "", environment: {} }));
    expect(await readStoredSetupCache(cacheDir, "wt-1", cwd)).toBeUndefined();
    await writeFile(sidecar, JSON.stringify({ fingerprint: 1, environment: {} }));
    expect(await readStoredSetupCache(cacheDir, "wt-1", cwd)).toBeUndefined();
  });

  it("merges host extras ahead of a scoped override without inventing paths", () => {
    expect(mergeSetupCacheInputs(["host.lock"], ["scoped.lock", "host.lock"])).toEqual([
      "host.lock",
      "scoped.lock",
    ]);
    expect(mergeSetupCacheInputs(undefined, [])).toEqual([]);
    expect(defaultSetupCacheDir("/home/harness")).toBe("/home/harness/.auto-harness/setup-cache");
  });
});
