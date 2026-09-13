import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { SessionAssign, SessionLogChunk } from "@auto-harness/shared";

import type { ProcessRunner } from "./executor.ts";
import { LogStreamer } from "./log-streamer.ts";
import { runSetupIfNeeded, type ClaimedWorktree } from "./session-run-setup.ts";
import { baseAssign } from "../test-helpers/session-runner-test-helpers.ts";

async function claim(extras?: {
  worktreeSetup?: string;
  worktreeCacheInputs?: string[];
  files?: Record<string, string>;
}): Promise<{ cwd: string; claimed: ClaimedWorktree }> {
  const cwd = await mkdtemp(join(tmpdir(), "auto-harness-setup-cache-run-"));
  for (const [name, contents] of Object.entries(extras?.files ?? {})) {
    await mkdir(join(join(cwd, name), ".."), { recursive: true });
    await writeFile(join(cwd, name), contents);
  }
  return {
    cwd,
    claimed: {
      repository: { id: "repo-1", path: cwd, defaultBranch: "main", worktrees: [] },
      worktree: {
        id: "wt-1",
        name: "wt-1",
        path: cwd,
        labels: [],
        ...(extras?.worktreeSetup !== undefined ? { setupScript: extras.worktreeSetup } : {}),
        ...(extras?.worktreeCacheInputs ? { setupCacheInputs: extras.worktreeCacheInputs } : {}),
      },
      cwd,
      currentHookTarget: async () => null,
    },
  };
}

function countingRunner(): { runner: ProcessRunner; calls: () => number } {
  const state = { calls: 0 };
  return {
    runner: {
      async run() {
        state.calls += 1;
        return { exitCode: 0, timedOut: false, signal: null, environment: {} };
      },
    },
    calls: () => state.calls,
  };
}

async function runCached(
  assign: SessionAssign,
  claimed: ClaimedWorktree,
  runner: ProcessRunner,
  cacheDir: string,
  baseline = "abc123",
) {
  const logs: SessionLogChunk[] = [];
  const streamer = new LogStreamer(
    "sess-1",
    "attempt-1",
    (chunk) => logs.push(chunk),
    () => "2026-08-01T00:00:00.000Z",
  );
  const { failure } = await runSetupIfNeeded(
    runner,
    streamer,
    logs,
    assign,
    claimed,
    undefined,
    () => false,
    () => 30_000,
    process.env,
    baseline,
    runner,
    process.env,
    false,
    undefined,
    undefined,
    cacheDir,
  );
  return {
    failure,
    system: logs.filter((chunk) => chunk.stream === "system").map((chunk) => chunk.content),
  };
}

describe("runSetupIfNeeded setup cache", () => {
  it("skips setup on a fresh session when the fingerprint matches", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "auto-harness-setup-cache-hit-"));
    const { claimed } = await claim({
      worktreeSetup: "pnpm install",
      worktreeCacheInputs: ["pnpm-lock.yaml"],
      files: { "pnpm-lock.yaml": "lock-1", "package.json": "pkg-1" },
    });
    const first = countingRunner();
    const firstRun = await runCached(baseAssign(), claimed, first.runner, cacheDir);
    expect(firstRun.failure).toBeNull();
    expect(first.calls()).toBe(1);
    expect(firstRun.system).toContain("Running setup script...");

    const second = countingRunner();
    const secondRun = await runCached(baseAssign(), claimed, second.runner, cacheDir);
    expect(secondRun.failure).toBeNull();
    expect(second.calls()).toBe(0);
    expect(secondRun.system).toContain("Setup unchanged; skipping.");
    expect(secondRun.system).not.toContain("Running setup script...");
  });

  it("still skips native resume even when the fingerprint would miss", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "auto-harness-setup-cache-resume-"));
    const { claimed } = await claim({ worktreeSetup: "pnpm install" });
    const runner = countingRunner();
    const { failure, system } = await runCached(
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
    const { cwd, claimed } = await claim({
      worktreeSetup: "pnpm install",
      worktreeCacheInputs: ["pnpm-lock.yaml"],
      files: { "pnpm-lock.yaml": "lock-1" },
    });
    await runCached(baseAssign(), claimed, countingRunner().runner, cacheDir);

    const scriptChanged = countingRunner();
    await runCached(
      baseAssign({ setupScript: "pnpm install --frozen-lockfile" }),
      claimed,
      scriptChanged.runner,
      cacheDir,
    );
    expect(scriptChanged.calls()).toBe(1);

    const refChanged = countingRunner();
    await runCached(baseAssign(), claimed, refChanged.runner, cacheDir, "other-sha");
    expect(refChanged.calls()).toBe(1);

    await writeFile(join(cwd, "pnpm-lock.yaml"), "lock-2");
    const extraChanged = countingRunner();
    await runCached(baseAssign(), claimed, extraChanged.runner, cacheDir);
    expect(extraChanged.calls()).toBe(1);
  });

  it("does not skip when a declared extra file is missing", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "auto-harness-setup-cache-absent-"));
    const { claimed } = await claim({
      worktreeSetup: "pnpm install",
      worktreeCacheInputs: ["pnpm-lock.yaml"],
    });
    const first = countingRunner();
    await runCached(baseAssign(), claimed, first.runner, cacheDir);
    expect(first.calls()).toBe(1);
    const second = countingRunner();
    await runCached(baseAssign(), claimed, second.runner, cacheDir);
    expect(second.calls()).toBe(1);
  });

  it("does not invalidate when an undeclared lockfile changes", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "auto-harness-setup-cache-undeclared-"));
    const { cwd, claimed } = await claim({
      worktreeSetup: "pnpm install",
      worktreeCacheInputs: ["declared.txt"],
      files: { "declared.txt": "ok", "pnpm-lock.yaml": "lock-1", "package.json": "pkg-1" },
    });
    await runCached(baseAssign(), claimed, countingRunner().runner, cacheDir);
    await writeFile(join(cwd, "pnpm-lock.yaml"), "lock-2");
    await writeFile(join(cwd, "package.json"), "pkg-2");
    const second = countingRunner();
    const secondRun = await runCached(baseAssign(), claimed, second.runner, cacheDir);
    expect(second.calls()).toBe(0);
    expect(secondRun.system).toContain("Setup unchanged; skipping.");
  });

  it("does not store a fingerprint after failed setup", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "auto-harness-setup-cache-fail-"));
    const { claimed } = await claim({ worktreeSetup: "false" });
    const failing: ProcessRunner = {
      async run() {
        return { exitCode: 1, timedOut: false, signal: null };
      },
    };
    const failed = await runCached(baseAssign(), claimed, failing, cacheDir);
    expect(failed.failure).toMatchObject({ status: "failed", errorCode: "setup_failed" });
    const second = countingRunner();
    await runCached(baseAssign(), claimed, second.runner, cacheDir);
    expect(second.calls()).toBe(1);
  });
});
