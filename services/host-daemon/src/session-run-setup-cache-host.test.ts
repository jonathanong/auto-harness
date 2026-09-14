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

describe("runSetupIfNeeded host-file cache", () => {
  it("re-runs setup when a declared host-owned file changes", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "auto-harness-setup-cache-host-run-"));
    const hostDir = await mkdtemp(join(tmpdir(), "auto-harness-setup-cache-host-env-"));
    const hostFile = join(hostDir, "host-environment");
    await writeFile(hostFile, "export TOKEN=one");
    const { claimed } = await claimSetupCache({
      worktreeSetup: ". /opt/auto-harness/setup/host-environment",
      worktreeCacheInputs: ["pnpm-lock.yaml"],
      hostAbsoluteCacheInputs: [hostFile],
      files: { "pnpm-lock.yaml": "lock-1" },
    });
    await runCachedSetup(baseAssign(), claimed, countingSetupRunner().runner, cacheDir);
    const hit = countingSetupRunner();
    expect((await runCachedSetup(baseAssign(), claimed, hit.runner, cacheDir)).system).toContain(
      "Setup unchanged; skipping.",
    );
    await writeFile(hostFile, "export TOKEN=two");
    const miss = countingSetupRunner();
    await runCachedSetup(baseAssign(), claimed, miss.runner, cacheDir);
    expect(miss.calls()).toBe(1);
  });

  it("keeps SHA/script/relative-extra skip when host files are omitted", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "auto-harness-setup-cache-host-omit-"));
    const hostDir = await mkdtemp(join(tmpdir(), "auto-harness-setup-cache-host-undeclared-"));
    const hostFile = join(hostDir, "host-environment");
    await writeFile(hostFile, "export TOKEN=one");
    const { claimed } = await claimSetupCache({
      worktreeSetup: "pnpm install",
      worktreeCacheInputs: ["pnpm-lock.yaml"],
      files: { "pnpm-lock.yaml": "lock-1" },
    });
    await runCachedSetup(baseAssign(), claimed, countingSetupRunner().runner, cacheDir);
    await writeFile(hostFile, "export TOKEN=two");
    const second = countingSetupRunner();
    const secondRun = await runCachedSetup(baseAssign(), claimed, second.runner, cacheDir);
    expect(second.calls()).toBe(0);
    expect(secondRun.system).toContain("Setup unchanged; skipping.");
  });

  it("does not skip when a declared host-owned file is missing", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "auto-harness-setup-cache-host-missing-"));
    const hostFile = join(tmpdir(), "auto-harness-setup-cache-host-absent", "host-environment");
    const { claimed } = await claimSetupCache({
      worktreeSetup: "pnpm install",
      hostAbsoluteCacheInputs: [hostFile],
    });
    const first = countingSetupRunner();
    await runCachedSetup(baseAssign(), claimed, first.runner, cacheDir);
    expect(first.calls()).toBe(1);
    const second = countingSetupRunner();
    await runCachedSetup(baseAssign(), claimed, second.runner, cacheDir);
    expect(second.calls()).toBe(1);
  });

  it("forwards a live abort signal while fingerprinting declared host files", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "auto-harness-setup-cache-host-signal-"));
    const hostDir = await mkdtemp(join(tmpdir(), "auto-harness-setup-cache-host-signal-env-"));
    const hostFile = join(hostDir, "host-environment");
    await writeFile(hostFile, "export TOKEN=one");
    const { claimed } = await claimSetupCache({
      worktreeSetup: "pnpm install",
      hostAbsoluteCacheInputs: [hostFile],
    });
    const first = countingSetupRunner();
    const firstRun = await runCachedSetup(
      baseAssign(),
      claimed,
      first.runner,
      cacheDir,
      "abc123",
      new AbortController().signal,
    );
    expect(firstRun.failure).toBeNull();
    expect(first.calls()).toBe(1);
    const hit = countingSetupRunner();
    const hitRun = await runCachedSetup(
      baseAssign(),
      claimed,
      hit.runner,
      cacheDir,
      "abc123",
      new AbortController().signal,
    );
    expect(hit.calls()).toBe(0);
    expect(hitRun.system).toContain("Setup unchanged; skipping.");
  });
});
