import { PACKAGE_SCOPE } from "@auto-harness/shared";

export const serviceName = `${PACKAGE_SCOPE}/agent` as const;

export function getServiceName(): string {
  return serviceName;
}

export {
  emptyAgentConfig,
  fetchAgentHostConfig,
  httpBaseFromApiUrl,
  inventoryFingerprint,
  loadAgentConfig,
  loadAgentIdentity,
  parseAgentConfig,
} from "./config.ts";
export type {
  AgentConfig,
  AgentIdentity,
  CommandProfileConfig,
  LoadConfigOptions,
  RepositoryConfig,
  WorktreeConfig,
} from "./config.ts";
export { resolveCommandArgv, UnknownCommandProfileError } from "./command-profiles.ts";
export { SpawnProcessRunner, runSetupScript } from "./executor.ts";
export type { OutputChunk, ProcessResult, ProcessRunner, RunProcessOptions } from "./executor.ts";
export { createGitClient } from "./git.ts";
export type { GitClient } from "./git.ts";
export { LogStreamer } from "./log-streamer.ts";
export { SessionRunner } from "./session-runner.ts";
export type { SessionRunResult, SessionRunnerDeps } from "./session-runner.ts";
export { runTerminalHook } from "./terminal-hook.ts";
export { detectUsageLimit } from "./usage-limit.ts";
export { WorktreeManager } from "./worktree-manager.ts";
export { runCli, main, createDefaultRunSessionDeps, normalizeCliArgs } from "./cli.ts";
export { ensureAgentReady, runAssignedSession } from "./runtime.ts";
export { AgentLoop, createLoopbackTransport } from "./agent-loop.ts";
export type { AgentLoopOptions, AgentTransport } from "./agent-loop.ts";
export { createWsTransport } from "./ws-transport.ts";
export { startAgentDaemon } from "./start-daemon.ts";
