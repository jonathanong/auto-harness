import { PACKAGE_SCOPE } from "@auto-harness/shared";

export const serviceName = `${PACKAGE_SCOPE}/agent` as const;

export function getServiceName(): string {
  return serviceName;
}

export { loadAgentConfig, parseAgentConfig } from "./config.js";
export type {
  AgentConfig,
  CommandProfileConfig,
  RepositoryConfig,
  WorktreeConfig,
} from "./config.js";
export { resolveCommandArgv, UnknownCommandProfileError } from "./command-profiles.js";
export { SpawnProcessRunner, runSetupScript } from "./executor.js";
export type { OutputChunk, ProcessResult, ProcessRunner, RunProcessOptions } from "./executor.js";
export { createGitClient } from "./git.js";
export type { GitClient } from "./git.js";
export { LogStreamer } from "./log-streamer.js";
export { SessionRunner } from "./session-runner.js";
export type { SessionRunResult, SessionRunnerDeps } from "./session-runner.js";
export { runTerminalHook } from "./terminal-hook.js";
export { detectUsageLimit } from "./usage-limit.js";
export { WorktreeManager } from "./worktree-manager.js";
export { runCli, main, createDefaultRunSessionDeps, normalizeCliArgs } from "./cli.js";
export { ensureAgentReady, runAssignedSession } from "./runtime.js";
export { AgentLoop, createLoopbackTransport } from "./agent-loop.js";
export type { AgentLoopOptions, AgentTransport } from "./agent-loop.js";
