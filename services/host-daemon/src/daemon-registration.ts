import type { HostToServerMessage } from "@auto-harness/shared";

import type { DaemonConfig } from "./config.ts";
import type { DaemonTransport } from "./daemon-transport-types.ts";
import { WorktreeManager } from "./worktree-manager.ts";

export async function registerDaemon(
  config: DaemonConfig,
  transport: Pick<DaemonTransport, "send">,
  runningSessions: readonly string[],
  draining = false,
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
    commandProfiles: Object.keys(config.commandProfiles).toSorted(),
    capabilities: ["scheduled-main-checkout"],
    runningSessions: [...runningSessions].toSorted(),
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
  const previousRepositories = config.repositories;
  const previousCommandProfiles = config.commandProfiles;
  const previousLogLevel = config.logLevel;
  config.repositories = next.repositories;
  config.commandProfiles = next.commandProfiles;
  if (next.logLevel) config.logLevel = next.logLevel;
  try {
    await worktrees.ensureAll();
    await register();
  } catch (err) {
    config.repositories = previousRepositories;
    config.commandProfiles = previousCommandProfiles;
    config.logLevel = previousLogLevel;
    throw err;
  }
}
