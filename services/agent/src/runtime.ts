import type { SessionAssign } from "@auto-harness/shared";

import type { AgentConfig } from "./config.js";
import type { ProcessRunner } from "./executor.js";
import { SpawnProcessRunner } from "./executor.js";
import { createGitClient } from "./git.js";
import type { SessionRunResult } from "./session-runner.js";
import { SessionRunner } from "./session-runner.js";
import { WorktreeManager } from "./worktree-manager.js";

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
    config,
    worktrees,
    processRunner,
    onLog: (c) => {
      onLog(`[${c.stream}#${c.seq}] ${c.content}`);
    },
  });
  return sessionRunner.run(assign);
}
