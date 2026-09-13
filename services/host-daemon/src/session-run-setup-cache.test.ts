import { writeFile } from "node:fs/promises";
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

describe("runSetupIfNeeded setup cache", () => {
  it("skips setup on a fresh session when the fingerprint matches", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "auto-harness-setup-cache-hit-"));
    const { claimed } = await claimSetupCache({
      worktreeSetup: "pnpm install",
      worktreeCacheInputs: ["pnpm-lock.yaml"],
      files: { "pnpm-lock.yaml": "lock-1", "package.json": "pkg-1" },
    });
    const first = countingSetupRunner();
    const firstRun = await runCachedSetup(baseAssign(), claimed, first.runner, cacheDir);
    expect(firstRun.failure).toBeNull();
    expect(first.calls()).toBe(1);
    expect(firstRun.system).toContain("Running setup script...");

    const second = countingSetupRunner();
    const secondRun = await runCachedSetup(baseAssign(), claimed, second.runner, cacheDir);
    expect(secondRun.failure).toBeNull();
    expect(second.calls()).toBe(0);
    expect(secondRun.system).toContain("Setup unchanged; skipping.");
    expect(secondRun.system).not.toContain("Running setup script...");
  });

  it("still skips native resume even when the fingerprint would miss", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "auto-harness-setup-cache-resume-"));
    const { claimed } = await claimSetupCache({ worktreeSetup: "pnpm install" });
    const runner = countingSetupRunner();
    const { failure, system } = await runCachedSetup(
      baseAssign({ resume: true }),
      claimed,
      runner.runner,
      cacheDir,
      "missing-sha",
    );
    expect(failure).toBeNull();
    expect(runner.calls()).toBe(0);
    expect(system).not.toContain("Setup unchanged; skipping.");
    expect(system).not.toContain("Running setup script...");
  });

  it("re-runs when the script, ref, or declared extra file changes", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "auto-harness-setup-cache-miss-"));
    const { cwd, claimed } = await claimSetupCache({
      worktreeSetup: "pnpm install",
      worktreeCacheInputs: ["pnpm-lock.yaml"],
      files: { "pnpm-lock.yaml": "lock-1" },
    });
    await runCachedSetup(baseAssign(), claimed, countingSetupRunner().runner, cacheDir);

    const scriptChanged = countingSetupRunner();
    await runCachedSetup(
      baseAssign({ setupScript: "pnpm install --frozen-lockfile" }),
      claimed,
      scriptChanged.runner,
      cacheDir,
    );
    expect(scriptChanged.calls()).toBe(1);

    const refChanged = countingSetupRunner();
    await runCachedSetup(baseAssign(), claimed, refChanged.runner, cacheDir, "other-sha");
    expect(refChanged.calls()).toBe(1);

    await writeFile(join(cwd, "pnpm-lock.yaml"), "lock-2");
    const extraChanged = countingSetupRunner();
    await runCachedSetup(baseAssign(), claimed, extraChanged.runner, cacheDir);
    expect(extraChanged.calls()).toBe(1);
  });

  it("does not skip when a declared extra file is missing", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "auto-harness-setup-cache-absent-"));
    const { claimed } = await claimSetupCache({
      worktreeSetup: "pnpm install",
      worktreeCacheInputs: ["pnpm-lock.yaml"],
    });
    const first = countingSetupRunner();
    await runCachedSetup(baseAssign(), claimed, first.runner, cacheDir);
    expect(first.calls()).toBe(1);
    const second = countingSetupRunner();
    await runCachedSetup(baseAssign(), claimed, second.runner, cacheDir);
    expect(second.calls()).toBe(1);
  });

  it("does not invalidate when an undeclared lockfile changes", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "auto-harness-setup-cache-undeclared-"));
    const { cwd, claimed } = await claimSetupCache({
      worktreeSetup: "pnpm install",
      worktreeCacheInputs: ["declared.txt"],
      files: { "declared.txt": "ok", "pnpm-lock.yaml": "lock-1", "package.json": "pkg-1" },
    });
    await runCachedSetup(baseAssign(), claimed, countingSetupRunner().runner, cacheDir);
    await writeFile(join(cwd, "pnpm-lock.yaml"), "lock-2");
    await writeFile(join(cwd, "package.json"), "pkg-2");
    const second = countingSetupRunner();
    const secondRun = await runCachedSetup(baseAssign(), claimed, second.runner, cacheDir);
    expect(second.calls()).toBe(0);
    expect(secondRun.system).toContain("Setup unchanged; skipping.");
  });

  it("does not store a fingerprint after failed setup", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "auto-harness-setup-cache-fail-"));
    const { claimed } = await claimSetupCache({ worktreeSetup: "false" });
    const failing: { run: () => Promise<{ exitCode: number; timedOut: boolean; signal: null }> } = {
      async run() {
        return { exitCode: 1, timedOut: false, signal: null };
      },
    };
    const failed = await runCachedSetup(baseAssign(), claimed, failing, cacheDir);
    expect(failed.failure).toMatchObject({ status: "failed", errorCode: "setup_failed" });
    const second = countingSetupRunner();
    await runCachedSetup(baseAssign(), claimed, second.runner, cacheDir);
    expect(second.calls()).toBe(1);
  });

  it("hashes host extras and falls back to repository extras", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "auto-harness-setup-cache-scopes-"));
    const { cwd, claimed } = await claimSetupCache({
      worktreeSetup: "pnpm install",
      hostCacheInputs: ["host.lock"],
      repositoryCacheInputs: ["repo.lock"],
      files: { "host.lock": "host-1", "repo.lock": "repo-1" },
    });
    await runCachedSetup(baseAssign(), claimed, countingSetupRunner().runner, cacheDir);
    const hit = countingSetupRunner();
    expect((await runCachedSetup(baseAssign(), claimed, hit.runner, cacheDir)).system).toContain(
      "Setup unchanged; skipping.",
    );
    expect(hit.calls()).toBe(0);
    await writeFile(join(cwd, "host.lock"), "host-2");
    const hostChanged = countingSetupRunner();
    await runCachedSetup(baseAssign(), claimed, hostChanged.runner, cacheDir);
    expect(hostChanged.calls()).toBe(1);
  });
});
