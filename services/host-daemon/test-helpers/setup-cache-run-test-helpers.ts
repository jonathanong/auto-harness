import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SessionAssign, SessionLogChunk } from "@auto-harness/shared";

import type { ProcessRunner } from "../src/executor.ts";
import { LogStreamer } from "../src/log-streamer.ts";
import { runSetupIfNeeded, type ClaimedWorktree } from "../src/session-run-setup.ts";

export async function claimSetupCache(extras?: {
  worktreeSetup?: string;
  worktreeCacheInputs?: string[];
  repositoryCacheInputs?: string[];
  hostCacheInputs?: string[];
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
      repository: {
        id: "repo-1",
        path: cwd,
        defaultBranch: "main",
        worktrees: [],
        ...(extras?.repositoryCacheInputs
          ? { setupCacheInputs: extras.repositoryCacheInputs }
          : {}),
      },
      worktree: {
        id: "wt-1",
        name: "wt-1",
        path: cwd,
        labels: [],
        ...(extras?.worktreeSetup !== undefined ? { setupScript: extras.worktreeSetup } : {}),
        ...(extras?.worktreeCacheInputs ? { setupCacheInputs: extras.worktreeCacheInputs } : {}),
      },
      cwd,
      ...(extras?.hostCacheInputs ? { hostSetupCacheInputs: extras.hostCacheInputs } : {}),
      currentHookTarget: async () => null,
    },
  };
}

export function countingSetupRunner(environment: NodeJS.ProcessEnv = {}) {
  const state = { calls: 0 };
  return {
    runner: {
      async run() {
        state.calls += 1;
        return { exitCode: 0, timedOut: false, signal: null, environment };
      },
    } satisfies ProcessRunner,
    calls: () => state.calls,
  };
}

export async function runCachedSetup(
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
  const { failure, environment } = await runSetupIfNeeded(
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
    environment,
    system: logs.filter((chunk) => chunk.stream === "system").map((chunk) => chunk.content),
  };
}
