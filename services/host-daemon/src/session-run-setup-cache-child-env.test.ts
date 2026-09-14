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

function childSource(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/bin",
    HOME: "/home/harness",
    HARNESS_CHILD_ENV_ALLOWLIST: "SETUP_TOKEN",
    SETUP_TOKEN: "old",
    ...overrides,
  };
}

describe("runSetupIfNeeded child-env cache", () => {
  it("re-runs setup when allowlisted child-env values change after a restart", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "auto-harness-setup-cache-child-env-run-"));
    const { claimed } = await claimSetupCache({
      worktreeSetup: "pnpm install",
      worktreeCacheInputs: ["pnpm-lock.yaml"],
      files: { "pnpm-lock.yaml": "lock-1" },
    });
    const first = countingSetupRunner({ SETUP_TOKEN: "from-setup" });
    const firstRun = await runCachedSetup(
      baseAssign(),
      claimed,
      first.runner,
      cacheDir,
      "abc123",
      undefined,
      childSource(),
    );
    expect(firstRun.failure).toBeNull();
    expect(first.calls()).toBe(1);
    expect(firstRun.system.join("\n")).not.toContain("old");
    expect(firstRun.system.join("\n")).not.toContain("from-setup");

    const hit = countingSetupRunner({ SETUP_TOKEN: "must-not-run" });
    const hitRun = await runCachedSetup(
      baseAssign(),
      claimed,
      hit.runner,
      cacheDir,
      "abc123",
      undefined,
      childSource(),
    );
    expect(hit.calls()).toBe(0);
    expect(hitRun.system).toContain("Setup unchanged; skipping.");
    expect(hitRun.environment).toMatchObject({ SETUP_TOKEN: "from-setup" });
    expect(hitRun.system.join("\n")).not.toContain("from-setup");
    expect(hitRun.system.join("\n")).not.toContain("must-not-run");

    const rotated = countingSetupRunner();
    await runCachedSetup(
      baseAssign(),
      claimed,
      rotated.runner,
      cacheDir,
      "abc123",
      undefined,
      childSource({ SETUP_TOKEN: "rotated" }),
    );
    expect(rotated.calls()).toBe(1);

    const pathChanged = countingSetupRunner();
    await runCachedSetup(
      baseAssign(),
      claimed,
      pathChanged.runner,
      cacheDir,
      "abc123",
      undefined,
      childSource({ PATH: "/opt/bin:/usr/bin" }),
    );
    expect(pathChanged.calls()).toBe(1);

    const removed = countingSetupRunner();
    await runCachedSetup(baseAssign(), claimed, removed.runner, cacheDir, "abc123", undefined, {
      PATH: "/usr/bin",
      HOME: "/home/harness",
    });
    expect(removed.calls()).toBe(1);
  });

  it("still skips native resume when the child env would miss", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "auto-harness-setup-cache-child-env-resume-"));
    const { claimed } = await claimSetupCache({ worktreeSetup: "pnpm install" });
    await runCachedSetup(
      baseAssign(),
      claimed,
      countingSetupRunner().runner,
      cacheDir,
      "abc123",
      undefined,
      childSource(),
    );
    const resume = countingSetupRunner();
    const { failure, system } = await runCachedSetup(
      baseAssign({ resume: true }),
      claimed,
      resume.runner,
      cacheDir,
      "abc123",
      undefined,
      childSource({ SETUP_TOKEN: "rotated" }),
    );
    expect(failure).toBeNull();
    expect(resume.calls()).toBe(0);
    expect(system).not.toContain("Setup unchanged; skipping.");
    expect(system).not.toContain("Running setup script...");
    expect(system.join("\n")).not.toContain("rotated");
  });
});
