/* eslint-disable max-lines -- registration reconciliation keeps its durable field layering together. */
import {
  validateHostRepositoryRegistrations,
  type HostRuntimeReport,
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

function sameLabels(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((label, index) => label === right[index]);
}

function previousWorktree(
  previous: HostInventoryRecord | undefined,
  worktree: RegisteredWorktree,
): HostInventoryRecord["repositories"][number]["worktrees"][number] | undefined {
  return previous?.repositories
    .find((repository) => repository.id === worktree.repositoryId)
    ?.worktrees.find((item) => item.id === worktree.id);
}

export type RegisteredDaemonIdentity = {
  instanceId: string;
  startedAt: string;
};

type RuntimeFields = Pick<
  HostInventoryRecord,
  "daemonInstanceId" | "daemonStartedAt" | "restartCount" | "lastRestartDetectedAt" | "runtime"
>;

/** Keep an operator's latest label edit when a stale daemon registration races it. */
function registeredWorktreeLabels(
  previous: HostInventoryRecord | undefined,
  worktree: RegisteredWorktree,
): string[] {
  const prior = previousWorktree(previous, worktree);
  // Rows written before the daemon snapshot existed are treated as operator-owned
  // during their first refresh; the next registration can then detect changes.
  if (!prior || prior.daemonLabels === undefined)
    return prior ? [...prior.labels] : [...worktree.labels];
  // A daemon repeating the same snapshot must not overwrite an operator edit.
  return sameLabels(worktree.labels, prior.daemonLabels) ? [...prior.labels] : [...worktree.labels];
}

/** Hide daemon-only label provenance from control-plane API consumers. */
export function withoutDaemonLabelProvenance(record: HostInventoryRecord): HostInventoryRecord {
  return {
    ...record,
    repositories: record.repositories.map((repository) => ({
      ...repository,
      worktrees: repository.worktrees.map(({ daemonLabels: _daemonLabels, ...worktree }) => ({
        ...worktree,
        labels: [...worktree.labels],
      })),
    })),
  };
}

/** Preserve daemon runtime observability through control-plane inventory edits. */
export function preservedDaemonRuntime(previous?: HostInventoryRecord): RuntimeFields {
  return {
    ...(previous?.daemonInstanceId ? { daemonInstanceId: previous.daemonInstanceId } : {}),
    ...(previous?.daemonStartedAt ? { daemonStartedAt: previous.daemonStartedAt } : {}),
    ...(previous?.restartCount !== undefined ? { restartCount: previous.restartCount } : {}),
    ...(previous?.lastRestartDetectedAt
      ? { lastRestartDetectedAt: previous.lastRestartDetectedAt }
      : {}),
    ...(previous?.runtime ? { runtime: previous.runtime } : {}),
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
  runtime?: HostRuntimeReport,
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
    ...(previous?.setupScript !== undefined ? { setupScript: previous.setupScript } : {}),
    ...(previous?.allowedRoots !== undefined ? { allowedRoots: [...previous.allowedRoots] } : {}),
    ...(previous?.requiredEnvironment !== undefined
      ? { requiredEnvironment: [...previous.requiredEnvironment] }
      : {}),
    // Advance the optimistic-concurrency counter rather than dropping it: a registration
    // is another whole-document replace, and leaving the attribute off would fail the
    // next conditional edit from the UI.
    version: (previous?.version ?? 0) + 1,
    ...nextDaemonRuntime(previous, daemonIdentity, updatedAt),
    ...(runtime ? { runtime } : {}),
    repositories: repositories.map((repository) => {
      const prior = priorById.get(repository.id);
      const advertised = worktreesByRepo.get(repository.id) ?? [];
      return {
        ...prior,
        id: repository.id,
        path: repository.path,
        defaultBranch: repository.defaultBranch ?? prior?.defaultBranch ?? "main",
        worktrees: advertised.map((worktree) => {
          const priorWorktree = prior?.worktrees.find((item) => item.id === worktree.id);
          return {
            ...priorWorktree,
            id: worktree.id,
            name: worktree.name,
            path: worktree.path,
            labels: registeredWorktreeLabels(previous, worktree),
            daemonLabels: [...worktree.labels],
          };
        }),
      };
    }),
    providerAccounts: previous?.providerAccounts.map((account) => ({ ...account })) ?? [],
    capabilities,
    updatedAt,
  };
}
