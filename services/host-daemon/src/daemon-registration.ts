import {
  HOST_PROTOCOL_VERSION,
  type HostRuntimeReport,
  type HostRunningAttempt,
  type HostToServerMessage,
} from "@auto-harness/shared";

import type { DaemonConfig } from "./config.ts";
import type { DaemonTransport } from "./daemon-transport-types.ts";
import {
  emptyExecutionProfiles,
  providerAccountReadiness,
  type ExecutionProfiles,
} from "./execution-profiles.ts";
import { WorktreeManager } from "./worktree-manager.ts";

export type DaemonRuntimeIdentity = {
  instanceId: string;
  startedAt: string;
};

export async function registerDaemon(
  config: DaemonConfig,
  transport: Pick<DaemonTransport, "send">,
  runningSessions: readonly string[],
  draining = false,
  identity?: DaemonRuntimeIdentity,
  runtime?: HostRuntimeReport,
  runningAttempts: readonly HostRunningAttempt[] = [],
  executionProfiles: ExecutionProfiles = emptyExecutionProfiles(),
): Promise<void> {
  // Registration is the reconnect barrier.  It deliberately bypasses the
  // producer-side FIFO so WsTransport can synchronously replace its pending
  // snapshot before it releases any buffered session traffic.
  const registration: Extract<HostToServerMessage, { type: "host:register" }> = {
    type: "host:register",
    hostId: config.hostId,
    worktrees: config.repositories.flatMap((repository) =>
      repository.worktrees.map((worktree) => ({
        id: worktree.id,
        name: worktree.name,
        repositoryId: repository.id,
        path: worktree.path,
        labels: worktree.labels,
      })),
    ),
    repositories: config.repositories
      .map(({ id, path, defaultBranch }) => ({ id, path, defaultBranch }))
      .toSorted((a, b) => a.id.localeCompare(b.id)),
    capabilities: {
      features: ["scheduled-main-checkout"],
      maxConcurrentAssignments: executionProfiles.maxConcurrentAssignments,
    },
    providerAccountReadiness: providerAccountReadiness(executionProfiles),
    protocolVersion: HOST_PROTOCOL_VERSION,
    runningSessions: [...runningSessions].toSorted(),
    runningAttempts: [...runningAttempts].toSorted(
      (left, right) =>
        left.sessionId.localeCompare(right.sessionId) ||
        left.attemptId.localeCompare(right.attemptId),
    ),
    ...(identity
      ? { daemonInstanceId: identity.instanceId, daemonStartedAt: identity.startedAt }
      : {}),
    ...(runtime ? { runtime } : {}),
    ...(draining ? { draining: true } : {}),
  };
  await transport.send(registration);
}

export async function applyDaemonInventory(
  config: DaemonConfig,
  next: DaemonConfig,
  worktrees: WorktreeManager,
  register: () => Promise<void>,
): Promise<void> {
  const previousSetupScript = config.setupScript;
  const previousAllowedRoots = config.allowedRoots;
  const previousRepositories = config.repositories;
  if (next.setupScript === undefined) delete config.setupScript;
  else config.setupScript = next.setupScript;
  if (next.allowedRoots === undefined) delete config.allowedRoots;
  else config.allowedRoots = next.allowedRoots;
  config.repositories = next.repositories;
  try {
    await worktrees.ensureAll();
    await register();
  } catch (err) {
    if (previousSetupScript === undefined) delete config.setupScript;
    else config.setupScript = previousSetupScript;
    if (previousAllowedRoots === undefined) delete config.allowedRoots;
    else config.allowedRoots = previousAllowedRoots;
    config.repositories = previousRepositories;
    throw err;
  }
}
