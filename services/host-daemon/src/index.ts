import { PACKAGE_SCOPE } from "@auto-harness/shared";

export const serviceName = `${PACKAGE_SCOPE}/host-daemon` as const;

export function getServiceName(): string {
  return serviceName;
}

export {
  emptyDaemonConfig,
  fetchHostInventory,
  httpBaseFromApiUrl,
  inventoryFingerprint,
  loadDaemonConfig,
  loadHostIdentity,
  parseDaemonConfig,
} from "./config.ts";
export type {
  DaemonConfig,
  HostIdentity,
  LoadConfigOptions,
  RepositoryConfig,
  WorktreeConfig,
} from "./config.ts";
export { SpawnProcessRunner } from "./executor.ts";
export type { OutputChunk, ProcessResult, ProcessRunner, RunProcessOptions } from "./executor.ts";
export { runSetupScript } from "./setup-script.ts";
export { PtyProcessRunner } from "./pty-runner.ts";
export type { PtyProcessRunnerDependencies, PtySpawn } from "./pty-runner.ts";
export { createChildEnv } from "./child-env.ts";
export { createGitClient } from "./git.ts";
export type { GitClient } from "./git.ts";
export { LogStreamer } from "./log-streamer.ts";
export { SessionRunner } from "./session-runner.ts";
export type { SessionRunResult, SessionRunnerDeps } from "./session-runner.ts";
export { runTerminalHook } from "./terminal-hook.ts";
export { detectUsageLimit } from "./usage-limit.ts";
export { WorktreeManager } from "./worktree-manager.ts";
export { runCli, main, createDefaultRunSessionDeps, normalizeCliArgs } from "./cli.ts";
export { ensureDaemonReady, runAssignedSession } from "./runtime.ts";
export { DaemonLoop, createLoopbackTransport } from "./daemon-loop.ts";
export type { DaemonLoopOptions, DaemonTransport } from "./daemon-loop.ts";
export { createWsTransport } from "./ws-transport.ts";
export { startDaemon } from "./start-daemon.ts";
export { AgentUpdater, canonicalManifest, parseAndVerifyManifest } from "./agent-updater.ts";
export type {
  AgentUpdaterOptions,
  UpdateFetcher,
  UpdateInstaller,
  UpdateLifecycle,
  UpdateManifest,
  UpdateState,
} from "./agent-updater.ts";
