import type { SessionAssign } from "@auto-harness/shared";

import type { DaemonConfig } from "./config.ts";
import type { ProcessRunner } from "./executor.ts";
import { SpawnProcessRunner } from "./executor.ts";
import { PtyProcessRunner } from "./pty-runner.ts";
import { createGitClient } from "./git.ts";
import type { SessionRunResult } from "./session-runner.ts";
import { SessionRunner } from "./session-runner.ts";
import { WorktreeManager } from "./worktree-manager.ts";

export async function ensureDaemonReady(
  config: DaemonConfig,
  processRunner: ProcessRunner = new SpawnProcessRunner(),
): Promise<void> {
  const git = createGitClient(processRunner);
  const worktrees = new WorktreeManager(config, git);
  await worktrees.ensureAll();
}

export async function runAssignedSession(
  config: DaemonConfig,
  assign: SessionAssign,
  onLog: (line: string) => void,
  processRunner: ProcessRunner = new SpawnProcessRunner(),
  commandRunner: ProcessRunner = new PtyProcessRunner(),
): Promise<SessionRunResult> {
  const git = createGitClient(processRunner);
  const worktrees = new WorktreeManager(config, git);
  const sessionRunner = new SessionRunner({
    worktrees,
    processRunner,
    commandRunner,
    onLog: (c) => {
      onLog(`[${c.stream}#${c.seq}] ${c.content}`);
    },
  });
  return sessionRunner.run(assign);
}
