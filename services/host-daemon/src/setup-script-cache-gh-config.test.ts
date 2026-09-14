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

function fingerprint(childEnv: NodeJS.ProcessEnv, appGeneratedGitHubConfigDir?: string): string {
  return fingerprintSetup({
    checkoutSha: "abc",
    scripts: ["pnpm install"],
    extraFiles: extras,
    childEnv,
    ...(appGeneratedGitHubConfigDir ? { appGeneratedGitHubConfigDir } : {}),
  });
}

async function storeSetup(
  childEnv: NodeJS.ProcessEnv,
  captured: NodeJS.ProcessEnv,
  appGeneratedGitHubConfigDir?: string,
) {
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
    ...(appGeneratedGitHubConfigDir ? { appGeneratedGitHubConfigDir } : {}),
  });
  if (first.skip || !first.fingerprintToStore) throw new Error("expected a fingerprint");
  await writeStoredSetupCache(cacheDir, "wt-1", cwd, first.fingerprintToStore, captured);
  return { cacheDir, cwd, fingerprintToStore: first.fingerprintToStore };
}

function resolve(
  cacheDir: string,
  cwd: string,
  childEnv: NodeJS.ProcessEnv,
  appGeneratedGitHubConfigDir?: string,
) {
  return resolveSetupCacheState({
    cacheDir,
    checkoutSha: "abc",
    cwd,
    worktreeId: "wt-1",
    scripts: ["pnpm install"],
    extraPaths: ["pnpm-lock.yaml"],
    childEnv,
    ...(appGeneratedGitHubConfigDir ? { appGeneratedGitHubConfigDir } : {}),
  });
}

describe("setup cache GH_CONFIG_DIR overlay", () => {
  it("omits only the session-minted isolation dir from the fingerprint", () => {
    const base = fingerprint({ PATH: "/usr/bin", TOKEN: "old" });
    const mintedA = appDir("aaaaaa");
    const mintedB = appDir("bbbbbb");
    const operatorA = fingerprint({ PATH: "/usr/bin", TOKEN: "old", GH_CONFIG_DIR: "/opt/gh-a" });
    const operatorB = fingerprint({ PATH: "/usr/bin", TOKEN: "old", GH_CONFIG_DIR: "/opt/gh-b" });
    expect(operatorA).not.toBe(base);
    expect(operatorB).not.toBe(base);
    expect(operatorA).not.toBe(operatorB);
    const shapedA = fingerprint({ PATH: "/usr/bin", TOKEN: "old", GH_CONFIG_DIR: mintedA });
    const shapedB = fingerprint({ PATH: "/usr/bin", TOKEN: "old", GH_CONFIG_DIR: mintedB });
    expect(shapedA).not.toBe(base);
    expect(shapedB).not.toBe(base);
    expect(shapedA).not.toBe(shapedB);
    expect(fingerprint({ PATH: "/usr/bin", TOKEN: "old", GH_CONFIG_DIR: mintedA }, mintedA)).toBe(
      base,
    );
    expect(fingerprint({ PATH: "/usr/bin", TOKEN: "old", GH_CONFIG_DIR: mintedB }, mintedB)).toBe(
      base,
    );
    expect(
      fingerprint({ PATH: "/usr/bin", TOKEN: "old", GH_CONFIG_DIR: mintedA }, mintedB),
    ).not.toBe(base);
    expect(
      fingerprint({ PATH: "/usr/bin", TOKEN: "old", GH_CONFIG_DIR: join(mintedA, "n") }, mintedA),
    ).not.toBe(base);
    expect(
      fingerprint(
        {
          PATH: "/usr/bin",
          TOKEN: "old",
          GH_CONFIG_DIR: join(tmpdir(), "auto-harness-gh-config-"),
        },
        mintedA,
      ),
    ).not.toBe(base);
  });

  it("does not restore a stored GH_CONFIG_DIR after the repo is unmapped", async () => {
    const stale = appDir("stale");
    const { cacheDir, cwd } = await storeSetup(
      { PATH: "/usr/bin", TOKEN: "old", GH_CONFIG_DIR: stale },
      { TOKEN: "from-setup", GH_CONFIG_DIR: stale },
      stale,
    );
    expect(await resolve(cacheDir, cwd, { PATH: "/usr/bin", TOKEN: "old" })).toEqual({
      skip: true,
      environment: { TOKEN: "from-setup" },
    });
  });

  it("misses when an operator-allowlisted GH_CONFIG_DIR changes", async () => {
    const { cacheDir, cwd, fingerprintToStore } = await storeSetup(
      { PATH: "/usr/bin", TOKEN: "old", GH_CONFIG_DIR: "/opt/gh-a" },
      { TOKEN: "from-setup", GH_CONFIG_DIR: "/opt/gh-a" },
    );
    const miss = await resolve(cacheDir, cwd, {
      PATH: "/usr/bin",
      TOKEN: "old",
      GH_CONFIG_DIR: "/opt/gh-b",
    });
    expect(miss.skip).toBe(false);
    expect(miss).toMatchObject({ fingerprintToStore: expect.any(String) });
    expect(miss.fingerprintToStore).not.toBe(fingerprintToStore);
  });

  it("misses when an operator App-shaped GH_CONFIG_DIR rotates without provenance", async () => {
    const { cacheDir, cwd, fingerprintToStore } = await storeSetup(
      { PATH: "/usr/bin", TOKEN: "old", GH_CONFIG_DIR: appDir("aaaaaa") },
      { TOKEN: "from-setup", GH_CONFIG_DIR: appDir("aaaaaa") },
    );
    const miss = await resolve(cacheDir, cwd, {
      PATH: "/usr/bin",
      TOKEN: "old",
      GH_CONFIG_DIR: appDir("bbbbbb"),
    });
    expect(miss.skip).toBe(false);
    expect(miss.fingerprintToStore).not.toBe(fingerprintToStore);
  });

  it("hits and keeps the live minted GH_CONFIG_DIR when only that path differs", async () => {
    const mintedA = appDir("aaaaaa");
    const mintedB = appDir("bbbbbb");
    const { cacheDir, cwd } = await storeSetup(
      { PATH: "/usr/bin", TOKEN: "old", GH_CONFIG_DIR: mintedA },
      { TOKEN: "from-setup", GH_CONFIG_DIR: mintedA },
      mintedA,
    );
    expect(
      await resolve(
        cacheDir,
        cwd,
        { PATH: "/usr/bin", TOKEN: "old", GH_CONFIG_DIR: mintedB },
        mintedB,
      ),
    ).toEqual({
      skip: true,
      environment: { TOKEN: "from-setup", GH_CONFIG_DIR: mintedB },
    });
  });

  it("restores a setup-exported GH_CONFIG_DIR on a cache hit", async () => {
    const { cacheDir, cwd } = await storeSetup(
      { PATH: "/usr/bin", TOKEN: "old" },
      { TOKEN: "from-setup", GH_CONFIG_DIR: "/opt/from-setup" },
    );
    expect(await resolve(cacheDir, cwd, { PATH: "/usr/bin", TOKEN: "old" })).toEqual({
      skip: true,
      environment: { TOKEN: "from-setup", GH_CONFIG_DIR: "/opt/from-setup" },
    });
  });

  it("drops stored isolation dirs that live child env no longer has", () => {
    const minted = appDir("minted");
    expect(
      applyLiveEphemeralChildEnv({ TOKEN: "from-setup", GH_CONFIG_DIR: appDir("stale") }),
    ).toEqual({ TOKEN: "from-setup" });
    expect(
      applyLiveEphemeralChildEnv({ TOKEN: "from-setup", GH_CONFIG_DIR: "/opt/from-setup" }),
    ).toEqual({ TOKEN: "from-setup", GH_CONFIG_DIR: "/opt/from-setup" });
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
    expect(
      applyLiveEphemeralChildEnv({ TOKEN: "from-setup", GH_CONFIG_DIR: minted }, {}, minted),
    ).toEqual({ TOKEN: "from-setup" });
    expect(
      applyLiveEphemeralChildEnv(
        { TOKEN: "from-setup", GH_CONFIG_DIR: "/opt/from-setup" },
        {},
        minted,
      ),
    ).toEqual({ TOKEN: "from-setup", GH_CONFIG_DIR: "/opt/from-setup" });
  });
});
