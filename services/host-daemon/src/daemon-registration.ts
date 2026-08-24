import {
  HOST_PROTOCOL_VERSION,
  MAX_HOST_REGISTRATION_BYTES,
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
  if (Buffer.byteLength(JSON.stringify(registration), "utf8") > MAX_HOST_REGISTRATION_BYTES) {
    throw new Error(
      `host registration exceeds ${String(MAX_HOST_REGISTRATION_BYTES)} byte WebSocket limit`,
    );
  }
  await transport.send(registration);
}

export async function applyDaemonInventory(
  config: DaemonConfig,
  next: DaemonConfig,
  worktrees: WorktreeManager,
  register: (candidate: DaemonConfig) => Promise<void>,
  afterApply?: () => void,
): Promise<void> {
  const previousSetupScript = config.setupScript;
  const previousAllowedRoots = config.allowedRoots;
  const previousRepositories = config.repositories;
  // Older test-only managers may not expose the generation hook; real managers always do.
  worktrees.noteInventoryChange?.();
  try {
    // Validate and register the candidate without replacing the live config or
    // retained roots policy. Pending terminal hooks must remain fail-closed
    // until the control plane has accepted this registration.
    await worktrees.ensureAll(next);
    await register(next);
    if (next.setupScript === undefined) delete config.setupScript;
    else config.setupScript = next.setupScript;
    if (next.allowedRoots === undefined) delete config.allowedRoots;
    else config.allowedRoots = next.allowedRoots;
    config.repositories = next.repositories;
    afterApply?.();
  } catch (err) {
    if (previousSetupScript === undefined) delete config.setupScript;
    else config.setupScript = previousSetupScript;
    if (previousAllowedRoots === undefined) delete config.allowedRoots;
    else config.allowedRoots = previousAllowedRoots;
    config.repositories = previousRepositories;
    // Claims that were revalidating during this attempt must retry against the
    // restored configuration too.
    worktrees.noteInventoryChange?.();
    throw err;
  }
}
