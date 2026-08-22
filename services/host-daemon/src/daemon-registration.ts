import type { HostRuntimeReport, HostToServerMessage } from "@auto-harness/shared";

import type { DaemonConfig } from "./config.ts";
import type { DaemonTransport } from "./daemon-transport-types.ts";
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
    capabilities: ["scheduled-main-checkout"],
    runningSessions: [...runningSessions].toSorted(),
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
  const previousRepositories = config.repositories;
  if (next.setupScript === undefined) delete config.setupScript;
  else config.setupScript = next.setupScript;
  config.repositories = next.repositories;
  try {
    await worktrees.ensureAll();
    await register();
  } catch (err) {
    if (previousSetupScript === undefined) delete config.setupScript;
    else config.setupScript = previousSetupScript;
    config.repositories = previousRepositories;
    throw err;
  }
}
