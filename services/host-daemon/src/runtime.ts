import type { HostRuntimeReport } from "@auto-harness/shared";

import type { DaemonConfig } from "./config.ts";
import type { ProcessRunner } from "./executor.ts";
import { SpawnProcessRunner } from "./executor.ts";
import { createGitClient } from "./git.ts";
import { WorktreeManager } from "./worktree-manager.ts";
import { probeGitReadiness } from "./git-readiness.ts";
import { WorkspaceManager } from "./workspace-manager.ts";
import { loadGitHubPullRefConfigs } from "./github-pull-ref-config.ts";

export async function ensureDaemonReady(
  config: DaemonConfig,
  processRunner: ProcessRunner = new SpawnProcessRunner(),
): Promise<HostRuntimeReport> {
  const runtime = await probeGitReadiness(processRunner);
  const workspaces = new WorkspaceManager(config);
  if (!runtime.gitReady) {
    // A workspace-only host can execute an explicitly capability-gated non-git
    // assignment. Repository/worktree startup remains Git-gated.
    if (config.repositories.length > 0) return runtime;
    await workspaces.ensureAll();
    return runtime;
  }
  const git = createGitClient(processRunner, loadGitHubPullRefConfigs());
  const worktrees = new WorktreeManager(config, git);
  await worktrees.ensureAll();
  await workspaces.ensureAll();
  return runtime;
}
