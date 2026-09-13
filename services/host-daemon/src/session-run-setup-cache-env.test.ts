import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { baseAssign } from "../test-helpers/session-runner-test-helpers.ts";
import {
  claimSetupCache,
  countingSetupRunner,
  runCachedSetup,
} from "../test-helpers/setup-cache-run-test-helpers.ts";
import { setupCacheFileName } from "./setup-script-cache.ts";

describe("runSetupIfNeeded setup cache environment", () => {
  it("restores captured exports on a fingerprint hit without re-running setup", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "auto-harness-setup-cache-env-"));
    const { claimed } = await claimSetupCache({ worktreeSetup: "source host-environment" });
    const first = countingSetupRunner({
      SETUP_TOKEN: "from-setup",
      PATH: "/opt/auto-harness/bin",
      HARNESS_API_KEY: "must-not-persist",
    });
    const firstRun = await runCachedSetup(baseAssign(), claimed, first.runner, cacheDir);
    expect(firstRun.failure).toBeNull();
    expect(first.calls()).toBe(1);
    expect(firstRun.environment).toMatchObject({
      SETUP_TOKEN: "from-setup",
      PATH: "/opt/auto-harness/bin",
    });
    expect(firstRun.environment.HARNESS_API_KEY).toBeUndefined();

    const second = countingSetupRunner({ SETUP_TOKEN: "must-not-run" });
    const secondRun = await runCachedSetup(baseAssign(), claimed, second.runner, cacheDir);
    expect(second.calls()).toBe(0);
    expect(secondRun.system).toContain("Setup unchanged; skipping.");
    expect(secondRun.environment).toMatchObject({
      SETUP_TOKEN: "from-setup",
      PATH: "/opt/auto-harness/bin",
    });
    expect(secondRun.environment.HARNESS_API_KEY).toBeUndefined();
  });

  it("treats a missing or corrupt sidecar as a cache miss", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "auto-harness-setup-cache-corrupt-"));
    const { claimed } = await claimSetupCache({ worktreeSetup: "pnpm install" });
    await runCachedSetup(baseAssign(), claimed, countingSetupRunner().runner, cacheDir);
    const sidecar = join(cacheDir, setupCacheFileName(claimed.worktree.id, claimed.cwd));
    await writeFile(sidecar, "not-json\n");
    const corrupt = countingSetupRunner();
    await runCachedSetup(baseAssign(), claimed, corrupt.runner, cacheDir);
    expect(corrupt.calls()).toBe(1);

    await writeFile(sidecar, JSON.stringify({ fingerprint: "abc" }));
    const missingEnv = countingSetupRunner();
    await runCachedSetup(baseAssign(), claimed, missingEnv.runner, cacheDir);
    expect(missingEnv.calls()).toBe(1);
  });

  it("does not fail the session when the cache sidecar cannot be stored", async () => {
    const parent = await mkdtemp(join(tmpdir(), "auto-harness-setup-cache-persist-"));
    const cacheDir = join(parent, "cache");
    await writeFile(cacheDir, "not-a-directory");
    const { claimed } = await claimSetupCache({ worktreeSetup: "pnpm install" });
    const first = countingSetupRunner({ SETUP_TOKEN: "from-setup" });
    const firstRun = await runCachedSetup(baseAssign(), claimed, first.runner, cacheDir);
    expect(firstRun.failure).toBeNull();
    expect(first.calls()).toBe(1);
    expect(firstRun.system).toContain(
      "Setup succeeded, but the setup cache could not be stored; the next fresh session will re-run setup.",
    );
    expect(firstRun.system.join("\n")).not.toContain("from-setup");

    const second = countingSetupRunner();
    const secondRun = await runCachedSetup(baseAssign(), claimed, second.runner, cacheDir);
    expect(secondRun.failure).toBeNull();
    expect(second.calls()).toBe(1);
  });
});
