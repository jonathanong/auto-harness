import type { DaemonConfig } from "./config.ts";
import type { DaemonTransport } from "./daemon-transport-types.ts";
import { WorktreeManager } from "./worktree-manager.ts";

export async function registerDaemon(
  config: DaemonConfig,
  transport: Pick<DaemonTransport, "send">,
  runningSessions: readonly string[],
): Promise<void> {
  // Registration is the reconnect barrier.  It deliberately bypasses the
  // producer-side FIFO so WsTransport can synchronously replace its pending
  // snapshot before it releases any buffered session traffic.
  await transport.send({
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
    commandProfiles: Object.keys(config.commandProfiles),
    runningSessions: [...runningSessions].toSorted(),
  });
}

export async function applyDaemonInventory(
  config: DaemonConfig,
  next: DaemonConfig,
  worktrees: WorktreeManager,
  register: () => Promise<void>,
): Promise<void> {
  config.repositories = next.repositories;
  config.commandProfiles = next.commandProfiles;
  if (next.logLevel) config.logLevel = next.logLevel;
  await worktrees.ensureAll();
  await register();
}
