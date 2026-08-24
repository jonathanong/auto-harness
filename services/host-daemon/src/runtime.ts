import type { HostRuntimeReport, SessionAssign } from "@auto-harness/shared";

import type { DaemonConfig } from "./config.ts";
import type { ProcessRunner } from "./executor.ts";
import { SpawnProcessRunner } from "./executor.ts";
import { PtyProcessRunner } from "./pty-runner.ts";
import { UsageCapturingProcessRunner } from "./usage-adapter.ts";
import { createGitClient } from "./git.ts";
import type { SessionRunResult } from "./session-runner.ts";
import { SessionRunner } from "./session-runner.ts";
import { WorktreeManager } from "./worktree-manager.ts";
import { loadExecutionProfiles } from "./execution-profiles.ts";
import { probeGitReadiness } from "./git-readiness.ts";

export async function ensureDaemonReady(
  config: DaemonConfig,
  processRunner: ProcessRunner = new SpawnProcessRunner(),
): Promise<HostRuntimeReport> {
  const runtime = await probeGitReadiness(processRunner);
  if (!runtime.gitReady) return runtime;
  const git = createGitClient(processRunner);
  const worktrees = new WorktreeManager(config, git);
  await worktrees.ensureAll();
  return runtime;
}

export async function runAssignedSession(
  config: DaemonConfig,
  assign: SessionAssign,
  onLog: (line: string) => void,
  processRunner: ProcessRunner = new SpawnProcessRunner(),
  commandRunner: ProcessRunner = new UsageCapturingProcessRunner(new PtyProcessRunner()),
  childEnvSource: NodeJS.ProcessEnv = process.env,
): Promise<SessionRunResult> {
  const runtime = await probeGitReadiness(processRunner);
  if (!runtime.gitReady) {
    throw new Error("Git 2.36 or newer with checkout recovery support is required");
  }
  const git = createGitClient(processRunner);
  const worktrees = new WorktreeManager(config, git);
  const sessionRunner = new SessionRunner({
    worktrees,
    processRunner,
    commandRunner,
    childEnvSource,
    executionProfiles: loadExecutionProfiles(childEnvSource),
    onLog: (c) => {
      onLog(`[${c.stream}#${c.seq}] ${c.content}`);
    },
  });
  return sessionRunner.run(assign);
}
