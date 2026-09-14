import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { applyLiveEphemeralChildEnv } from "./setup-script-cache-hash.ts";
import {
  fingerprintSetup,
  resolveSetupCacheState,
  writeStoredSetupCache,
} from "./setup-script-cache.ts";

const extras = [{ path: "pnpm-lock.yaml", contents: Buffer.from("lock-a") }];
const appDir = (suffix: string) => join(tmpdir(), `auto-harness-gh-config-${suffix}`);

function fingerprint(childEnv: NodeJS.ProcessEnv): string {
  return fingerprintSetup({
    checkoutSha: "abc",
    scripts: ["pnpm install"],
    extraFiles: extras,
    childEnv,
  });
}

async function storeSetup(childEnv: NodeJS.ProcessEnv, captured: NodeJS.ProcessEnv) {
  const cwd = await mkdtemp(join(tmpdir(), "auto-harness-setup-cache-gh-config-"));
  const cacheDir = await mkdtemp(join(tmpdir(), "auto-harness-setup-cache-gh-config-store-"));
  await writeFile(join(cwd, "pnpm-lock.yaml"), "lock-a");
  const first = await resolveSetupCacheState({
    cacheDir,
    checkoutSha: "abc",
    cwd,
    worktreeId: "wt-1",
    scripts: ["pnpm install"],
    extraPaths: ["pnpm-lock.yaml"],
    childEnv,
  });
  if (first.skip || !first.fingerprintToStore) throw new Error("expected a fingerprint");
  await writeStoredSetupCache(cacheDir, "wt-1", cwd, first.fingerprintToStore, captured);
  return { cacheDir, cwd, fingerprintToStore: first.fingerprintToStore };
}

describe("setup cache GH_CONFIG_DIR overlay", () => {
  it("omits App-generated isolation dirs and fingerprints operator-allowlisted paths", () => {
    const base = fingerprint({ PATH: "/usr/bin", TOKEN: "old" });
    const operatorA = fingerprint({ PATH: "/usr/bin", TOKEN: "old", GH_CONFIG_DIR: "/opt/gh-a" });
    const operatorB = fingerprint({ PATH: "/usr/bin", TOKEN: "old", GH_CONFIG_DIR: "/opt/gh-b" });
    expect(operatorA).not.toBe(base);
    expect(operatorB).not.toBe(base);
    expect(operatorA).not.toBe(operatorB);
    expect(fingerprint({ PATH: "/usr/bin", TOKEN: "old", GH_CONFIG_DIR: appDir("aaaaaa") })).toBe(
      base,
    );
    expect(fingerprint({ PATH: "/usr/bin", TOKEN: "old", GH_CONFIG_DIR: appDir("bbbbbb") })).toBe(
      base,
    );
    expect(
      fingerprint({ PATH: "/usr/bin", TOKEN: "old", GH_CONFIG_DIR: join(appDir("aaaaaa"), "n") }),
    ).not.toBe(base);
    expect(
      fingerprint({
        PATH: "/usr/bin",
        TOKEN: "old",
        GH_CONFIG_DIR: join(tmpdir(), "auto-harness-gh-config-"),
      }),
    ).not.toBe(base);
  });

  it("does not restore a stored GH_CONFIG_DIR after the repo is unmapped", async () => {
    const { cacheDir, cwd } = await storeSetup(
      { PATH: "/usr/bin", TOKEN: "old", GH_CONFIG_DIR: appDir("stale") },
      { TOKEN: "from-setup", GH_CONFIG_DIR: appDir("stale") },
    );
    expect(
      await resolveSetupCacheState({
        cacheDir,
        checkoutSha: "abc",
        cwd,
        worktreeId: "wt-1",
        scripts: ["pnpm install"],
        extraPaths: ["pnpm-lock.yaml"],
        childEnv: { PATH: "/usr/bin", TOKEN: "old" },
      }),
    ).toEqual({ skip: true, environment: { TOKEN: "from-setup" } });
  });

  it("misses when an operator-allowlisted GH_CONFIG_DIR changes", async () => {
    const { cacheDir, cwd, fingerprintToStore } = await storeSetup(
      { PATH: "/usr/bin", TOKEN: "old", GH_CONFIG_DIR: "/opt/gh-a" },
      { TOKEN: "from-setup", GH_CONFIG_DIR: "/opt/gh-a" },
    );
    const miss = await resolveSetupCacheState({
      cacheDir,
      checkoutSha: "abc",
      cwd,
      worktreeId: "wt-1",
      scripts: ["pnpm install"],
      extraPaths: ["pnpm-lock.yaml"],
      childEnv: { PATH: "/usr/bin", TOKEN: "old", GH_CONFIG_DIR: "/opt/gh-b" },
    });
    expect(miss.skip).toBe(false);
    expect(miss).toMatchObject({ fingerprintToStore: expect.any(String) });
    expect(miss.fingerprintToStore).not.toBe(fingerprintToStore);
  });

  it("hits and keeps the live App-generated GH_CONFIG_DIR when only that path differs", async () => {
    const { cacheDir, cwd } = await storeSetup(
      { PATH: "/usr/bin", TOKEN: "old", GH_CONFIG_DIR: appDir("aaaaaa") },
      { TOKEN: "from-setup", GH_CONFIG_DIR: appDir("aaaaaa") },
    );
    expect(
      await resolveSetupCacheState({
        cacheDir,
        checkoutSha: "abc",
        cwd,
        worktreeId: "wt-1",
        scripts: ["pnpm install"],
        extraPaths: ["pnpm-lock.yaml"],
        childEnv: { PATH: "/usr/bin", TOKEN: "old", GH_CONFIG_DIR: appDir("bbbbbb") },
      }),
    ).toEqual({
      skip: true,
      environment: { TOKEN: "from-setup", GH_CONFIG_DIR: appDir("bbbbbb") },
    });
  });

  it("drops stored isolation dirs that live child env no longer has", () => {
    expect(
      applyLiveEphemeralChildEnv({ TOKEN: "from-setup", GH_CONFIG_DIR: appDir("stale") }),
    ).toEqual({ TOKEN: "from-setup" });
    expect(
      applyLiveEphemeralChildEnv(
        { TOKEN: "from-setup", GH_CONFIG_DIR: appDir("stale") },
        { TOKEN: "from-setup", GH_CONFIG_DIR: appDir("live") },
      ),
    ).toEqual({ TOKEN: "from-setup", GH_CONFIG_DIR: appDir("live") });
    expect(
      applyLiveEphemeralChildEnv(
        { TOKEN: "from-setup", GH_CONFIG_DIR: "/opt/gh-a" },
        { TOKEN: "from-setup", GH_CONFIG_DIR: "/opt/gh-a" },
      ),
    ).toEqual({ TOKEN: "from-setup", GH_CONFIG_DIR: "/opt/gh-a" });
  });
});
