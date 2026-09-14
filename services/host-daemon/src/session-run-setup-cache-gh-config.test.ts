import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { baseAssign } from "../test-helpers/session-runner-test-helpers.ts";
import {
  claimSetupCache,
  countingSetupRunner,
  runCachedSetup,
} from "../test-helpers/setup-cache-run-test-helpers.ts";

const appDir = (suffix: string) => join(tmpdir(), `auto-harness-gh-config-${suffix}`);

function childSource(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/bin",
    HOME: "/home/harness",
    HARNESS_CHILD_ENV_ALLOWLIST: "SETUP_TOKEN,GH_CONFIG_DIR",
    SETUP_TOKEN: "old",
    ...overrides,
  };
}

async function primedCache(
  captured: NodeJS.ProcessEnv,
  source: NodeJS.ProcessEnv,
  isolatedGitHubConfigDir?: string,
) {
  const cacheDir = await mkdtemp(join(tmpdir(), "auto-harness-setup-cache-gh-config-run-"));
  const { claimed } = await claimSetupCache({
    worktreeSetup: "pnpm install",
    worktreeCacheInputs: ["pnpm-lock.yaml"],
    files: { "pnpm-lock.yaml": "lock-1" },
  });
  const first = countingSetupRunner(captured);
  const firstRun = await runCachedSetup(
    baseAssign(),
    claimed,
    first.runner,
    cacheDir,
    "abc123",
    undefined,
    source,
    isolatedGitHubConfigDir,
  );
  expect(firstRun.failure).toBeNull();
  expect(first.calls()).toBe(1);
  return { cacheDir, claimed };
}

describe("runSetupIfNeeded GH_CONFIG_DIR cache", () => {
  it("does not restore a deleted GH_CONFIG_DIR after the repo is unmapped", async () => {
    const stale = appDir("stale");
    const { cacheDir, claimed } = await primedCache(
      { SETUP_TOKEN: "from-setup", GH_CONFIG_DIR: stale },
      childSource({ GH_CONFIG_DIR: stale }),
      stale,
    );
    const second = countingSetupRunner({ SETUP_TOKEN: "must-not-run" });
    const secondRun = await runCachedSetup(
      baseAssign(),
      claimed,
      second.runner,
      cacheDir,
      "abc123",
      undefined,
      {
        PATH: "/usr/bin",
        HOME: "/home/harness",
        HARNESS_CHILD_ENV_ALLOWLIST: "SETUP_TOKEN",
        SETUP_TOKEN: "old",
      },
    );
    expect(second.calls()).toBe(0);
    expect(secondRun.system).toContain("Setup unchanged; skipping.");
    expect(secondRun.environment).toEqual({ SETUP_TOKEN: "from-setup" });
    expect(secondRun.environment).not.toHaveProperty("GH_CONFIG_DIR");
    expect(secondRun.system.join("\n")).not.toContain("from-setup");
    expect(secondRun.system.join("\n")).not.toContain(stale);
  });

  it("restores a setup-exported GH_CONFIG_DIR on a cache hit", async () => {
    const source = {
      PATH: "/usr/bin",
      HOME: "/home/harness",
      HARNESS_CHILD_ENV_ALLOWLIST: "SETUP_TOKEN",
      SETUP_TOKEN: "old",
    };
    const { cacheDir, claimed } = await primedCache(
      { SETUP_TOKEN: "from-setup", GH_CONFIG_DIR: "/opt/from-setup" },
      source,
    );
    const second = countingSetupRunner({ SETUP_TOKEN: "must-not-run" });
    const secondRun = await runCachedSetup(
      baseAssign(),
      claimed,
      second.runner,
      cacheDir,
      "abc123",
      undefined,
      source,
    );
    expect(second.calls()).toBe(0);
    expect(secondRun.system).toContain("Setup unchanged; skipping.");
    expect(secondRun.environment).toEqual({
      SETUP_TOKEN: "from-setup",
      GH_CONFIG_DIR: "/opt/from-setup",
    });
    expect(secondRun.system.join("\n")).not.toContain("from-setup");
    expect(secondRun.system.join("\n")).not.toContain("/opt/from-setup");
  });

  it("re-runs setup when an operator-allowlisted GH_CONFIG_DIR changes", async () => {
    const { cacheDir, claimed } = await primedCache(
      { SETUP_TOKEN: "from-setup", GH_CONFIG_DIR: "/opt/gh-a" },
      childSource({ GH_CONFIG_DIR: "/opt/gh-a" }),
    );
    const rotated = countingSetupRunner();
    const rotatedRun = await runCachedSetup(
      baseAssign(),
      claimed,
      rotated.runner,
      cacheDir,
      "abc123",
      undefined,
      childSource({ GH_CONFIG_DIR: "/opt/gh-b" }),
    );
    expect(rotated.calls()).toBe(1);
    expect(rotatedRun.system).not.toContain("Setup unchanged; skipping.");
    expect(rotatedRun.system.join("\n")).not.toContain("/opt/gh-");
    expect(rotatedRun.system.join("\n")).not.toContain("from-setup");
  });

  it("re-runs setup when an operator App-shaped GH_CONFIG_DIR rotates", async () => {
    const { cacheDir, claimed } = await primedCache(
      { SETUP_TOKEN: "from-setup", GH_CONFIG_DIR: appDir("aaaaaa") },
      childSource({ GH_CONFIG_DIR: appDir("aaaaaa") }),
    );
    const rotated = countingSetupRunner();
    const rotatedRun = await runCachedSetup(
      baseAssign(),
      claimed,
      rotated.runner,
      cacheDir,
      "abc123",
      undefined,
      childSource({ GH_CONFIG_DIR: appDir("bbbbbb") }),
    );
    expect(rotated.calls()).toBe(1);
    expect(rotatedRun.system).not.toContain("Setup unchanged; skipping.");
    expect(rotatedRun.system.join("\n")).not.toContain(appDir("aaaaaa"));
    expect(rotatedRun.system.join("\n")).not.toContain(appDir("bbbbbb"));
    expect(rotatedRun.system.join("\n")).not.toContain("from-setup");
  });

  it("skips setup when only the minted GH_CONFIG_DIR differs across sessions", async () => {
    const mintedA = appDir("aaaaaa");
    const mintedB = appDir("bbbbbb");
    const { cacheDir, claimed } = await primedCache(
      { SETUP_TOKEN: "from-setup", GH_CONFIG_DIR: mintedA },
      childSource({ GH_CONFIG_DIR: mintedA }),
      mintedA,
    );
    const second = countingSetupRunner({ SETUP_TOKEN: "must-not-run" });
    const secondRun = await runCachedSetup(
      baseAssign(),
      claimed,
      second.runner,
      cacheDir,
      "abc123",
      undefined,
      childSource({ GH_CONFIG_DIR: mintedB }),
      mintedB,
    );
    expect(second.calls()).toBe(0);
    expect(secondRun.system).toContain("Setup unchanged; skipping.");
    expect(secondRun.environment.GH_CONFIG_DIR).toBe(mintedB);
    expect(secondRun.environment).toMatchObject({ SETUP_TOKEN: "from-setup" });
    expect(secondRun.system.join("\n")).not.toContain(mintedA);
    expect(secondRun.system.join("\n")).not.toContain(mintedB);
    expect(secondRun.system.join("\n")).not.toContain("from-setup");
  });
});
