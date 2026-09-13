import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  defaultSetupCacheDir,
  fingerprintSetup,
  mergeSetupCacheInputs,
  readDeclaredSetupFiles,
  readStoredSetupFingerprint,
  writeStoredSetupFingerprint,
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

  it("persists fingerprints outside the checkout", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "auto-harness-setup-cache-dir-"));
    const cwd = await mkdir(join(cacheDir, "checkout"), { recursive: true });
    await writeStoredSetupFingerprint(cacheDir, "wt-1", cwd, "abc");
    expect(await readStoredSetupFingerprint(cacheDir, "wt-1", cwd)).toBe("abc");
    expect(await readFile(join(cwd, "abc"), "utf8").catch(() => "missing")).toBe("missing");
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
