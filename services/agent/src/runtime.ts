import type { SessionAssign } from "@auto-harness/shared";

import type { AgentConfig } from "./config.ts";
import type { ProcessRunner } from "./executor.ts";
import { SpawnProcessRunner } from "./executor.ts";
import { createGitClient } from "./git.ts";
import type { SessionRunResult } from "./session-runner.ts";
import { SessionRunner } from "./session-runner.ts";
import { WorktreeManager } from "./worktree-manager.ts";

export async function ensureAgentReady(
  config: AgentConfig,
  processRunner: ProcessRunner = new SpawnProcessRunner(),
): Promise<void> {
  const git = createGitClient(processRunner);
  const worktrees = new WorktreeManager(config, git);
  await worktrees.ensureAll();
}

export async function runAssignedSession(
  config: AgentConfig,
  assign: SessionAssign,
  onLog: (line: string) => void,
  processRunner: ProcessRunner = new SpawnProcessRunner(),
): Promise<SessionRunResult> {
  const git = createGitClient(processRunner);
  const worktrees = new WorktreeManager(config, git);
  const sessionRunner = new SessionRunner({
    worktrees,
    processRunner,
    onLog: (c) => {
      onLog(`[${c.stream}#${c.seq}] ${c.content}`);
    },
  });
  return sessionRunner.run(assign);
}
