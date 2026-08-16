import {
  validateHostRepositoryRegistrations,
  type HostRepositoryRegistration,
} from "@auto-harness/shared";

import type { HostInventoryRecord } from "./db/plane-storage.ts";

type RegisteredWorktree = {
  id: string;
  name: string;
  repositoryId: string;
  path: string;
  labels: string[];
};

export type RegisteredDaemonIdentity = {
  instanceId: string;
  startedAt: string;
};

type RuntimeFields = Pick<
  HostInventoryRecord,
  "daemonInstanceId" | "daemonStartedAt" | "restartCount" | "lastRestartDetectedAt"
>;

/** Preserve local runtime observability through inventory edits and legacy registrations. */
export function preservedDaemonRuntime(previous?: HostInventoryRecord): RuntimeFields {
  return {
    ...(previous?.daemonInstanceId ? { daemonInstanceId: previous.daemonInstanceId } : {}),
    ...(previous?.daemonStartedAt ? { daemonStartedAt: previous.daemonStartedAt } : {}),
    ...(previous?.restartCount !== undefined ? { restartCount: previous.restartCount } : {}),
    ...(previous?.lastRestartDetectedAt
      ? { lastRestartDetectedAt: previous.lastRestartDetectedAt }
      : {}),
  };
}

/** First modern registration establishes a baseline; only a known identity change counts. */
function nextDaemonRuntime(
  previous: HostInventoryRecord | undefined,
  identity: RegisteredDaemonIdentity | undefined,
  detectedAt: string,
): RuntimeFields {
  if (!identity) return preservedDaemonRuntime(previous);
  const priorCount = previous?.restartCount ?? 0;
  const changed =
    previous?.daemonInstanceId !== undefined && previous.daemonInstanceId !== identity.instanceId;
  return {
    daemonInstanceId: identity.instanceId,
    daemonStartedAt:
      previous?.daemonInstanceId === identity.instanceId && previous.daemonStartedAt
        ? previous.daemonStartedAt
        : identity.startedAt,
    restartCount: priorCount + (changed ? 1 : 0),
    ...(changed
      ? { lastRestartDetectedAt: detectedAt }
      : previous?.lastRestartDetectedAt
        ? { lastRestartDetectedAt: previous.lastRestartDetectedAt }
        : {}),
  };
}

/** Parse the optional repository portion of a host registration message. */
export function parseHostRegistrationRepositories(
  raw: unknown,
): HostRepositoryRegistration[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw new Error("repositories must be an array");
  const repositories: HostRepositoryRegistration[] = [];
  for (const [index, value] of raw.entries()) {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      typeof (value as { id?: unknown }).id !== "string" ||
      typeof (value as { path?: unknown }).path !== "string"
    ) {
      throw new Error(`repositories[${index}] must contain id and path`);
    }
    const entry = value as { id: string; path: string; defaultBranch?: unknown };
    if (entry.id.length === 0 || entry.path.length === 0) {
      throw new Error(`repositories[${index}] id and path must be non-empty strings`);
    }
    if (entry.defaultBranch !== undefined && typeof entry.defaultBranch !== "string") {
      throw new Error(`repositories[${index}].defaultBranch must be a string`);
    }
    repositories.push({
      id: entry.id,
      path: entry.path,
      ...(entry.defaultBranch !== undefined ? { defaultBranch: entry.defaultBranch } : {}),
    });
  }
  const error = validateHostRepositoryRegistrations(repositories);
  if (error) throw new Error(error);
  return repositories;
}

function repositoriesFromWorktrees(
  worktrees: readonly RegisteredWorktree[],
): HostRepositoryRegistration[] {
  const byId = new Map<string, HostRepositoryRegistration>();
  for (const worktree of worktrees) {
    if (!byId.has(worktree.repositoryId)) {
      byId.set(worktree.repositoryId, {
        id: worktree.repositoryId,
        path: worktree.path,
        defaultBranch: "main",
      });
    }
  }
  return [...byId.values()];
}

/**
 * Keep explicit inventory from a previous registration when an older daemon
 * omits `repositories`; otherwise derive a best-effort repository list from
 * its worktree advertisements.
 */
export function resolveRegisteredRepositories(
  repositories: readonly HostRepositoryRegistration[] | undefined,
  worktrees: readonly RegisteredWorktree[],
  previous: HostInventoryRecord | undefined,
): HostRepositoryRegistration[] {
  if (repositories !== undefined) return repositories.map((repository) => ({ ...repository }));
  if (previous && previous.repositories.length > 0) {
    return previous.repositories.map(({ id, path, defaultBranch }) => ({
      id,
      path,
      defaultBranch,
    }));
  }
  return repositoriesFromWorktrees(worktrees);
}

export function buildRegisteredInventory(
  hostId: string,
  repositories: readonly HostRepositoryRegistration[],
  worktrees: readonly RegisteredWorktree[],
  capabilities: HostInventoryRecord["capabilities"],
  updatedAt: string,
  previous?: HostInventoryRecord,
  daemonIdentity?: RegisteredDaemonIdentity,
): HostInventoryRecord {
  const priorById = new Map(
    (previous?.repositories ?? []).map((repository) => [repository.id, repository]),
  );
  const worktreesByRepo = new Map<string, RegisteredWorktree[]>();
  for (const worktree of worktrees) {
    const existing = worktreesByRepo.get(worktree.repositoryId) ?? [];
    existing.push(worktree);
    worktreesByRepo.set(worktree.repositoryId, existing);
  }
  return {
    hostId,
    // Advance the optimistic-concurrency counter rather than dropping it: a registration
    // is another whole-document replace, and leaving the attribute off would fail the
    // next conditional edit from the UI.
    version: (previous?.version ?? 0) + 1,
    ...nextDaemonRuntime(previous, daemonIdentity, updatedAt),
    repositories: repositories.map((repository) => {
      const prior = priorById.get(repository.id);
      const advertised = worktreesByRepo.get(repository.id) ?? [];
      return {
        ...prior,
        id: repository.id,
        path: repository.path,
        defaultBranch: repository.defaultBranch ?? prior?.defaultBranch ?? "main",
        worktrees: advertised.map((worktree) => ({
          id: worktree.id,
          name: worktree.name,
          path: worktree.path,
          labels: [...worktree.labels],
          ...(prior?.worktrees.find((item) => item.id === worktree.id)?.setupScript !== undefined
            ? { setupScript: prior.worktrees.find((item) => item.id === worktree.id)?.setupScript }
            : {}),
        })),
      };
    }),
    providerAccounts: previous?.providerAccounts.map((account) => ({ ...account })) ?? [],
    capabilities,
    updatedAt,
  };
}
