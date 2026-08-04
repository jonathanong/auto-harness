/** Pure helpers for agent host inventory (used by both control + agent UIs). */

export type HostWorktree = {
  /** Auto-generated (UUIDv7), immutable. */
  id: string;
  /** User-chosen, slug-validated, unique across all hosts. */
  name: string;
  path: string;
  labels: string[];
};

export type HostRepository = {
  id: string;
  path: string;
  defaultBranch: string;
  worktrees: HostWorktree[];
};

export type HostInventory = {
  repositories: HostRepository[];
  commandProfiles: Record<string, { argv: string[]; appendPrompt: boolean }>;
};

export const DEFAULT_ECHO_PROFILE: HostInventory["commandProfiles"] = {
  "echo-prompt": { argv: ["echo"], appendPrompt: true },
};

/** Suggested path only — never auto-persist without explicit worktree create. */
export function defaultWorktreePath(repoPath: string, worktreeName: string): string {
  return `${repoPath.replace(/\/$/, "")}/.worktrees/${worktreeName}`;
}

function seedProfiles(
  existing: HostInventory | null | undefined,
): HostInventory["commandProfiles"] {
  if (existing?.commandProfiles && Object.keys(existing.commandProfiles).length > 0) {
    return { ...existing.commandProfiles };
  }
  return { ...DEFAULT_ECHO_PROFILE };
}

function cloneInventory(existing: HostInventory | null | undefined): HostInventory {
  return {
    repositories: existing?.repositories
      ? existing.repositories.map((r) => ({
          ...r,
          worktrees: r.worktrees.map((w) => ({ ...w, labels: [...w.labels] })),
        }))
      : [],
    commandProfiles: seedProfiles(existing),
  };
}

/**
 * Upsert repository metadata only. Does not invent worktrees.
 * New repos get `worktrees: []`; existing worktrees are preserved on same id.
 */
export function upsertHostRepository(
  existing: HostInventory | null | undefined,
  entry: {
    id: string;
    path: string;
    defaultBranch: string;
  },
): HostInventory {
  const base = cloneInventory(existing);
  const prev = base.repositories.find((r) => r.id === entry.id);
  base.repositories = base.repositories.filter((r) => r.id !== entry.id);
  base.repositories.push({
    id: entry.id,
    path: entry.path,
    defaultBranch: entry.defaultBranch,
    worktrees: prev ? prev.worktrees.map((w) => ({ ...w, labels: [...w.labels] })) : [],
  });
  return base;
}

export function removeHostRepository(
  existing: HostInventory | null | undefined,
  repositoryId: string,
): HostInventory {
  const base = cloneInventory(existing);
  base.repositories = base.repositories.filter((r) => r.id !== repositoryId);
  return base;
}

export function addHostWorktree(
  existing: HostInventory | null | undefined,
  repositoryId: string,
  worktree: HostWorktree,
): HostInventory {
  const base = cloneInventory(existing);
  const repo = base.repositories.find((r) => r.id === repositoryId);
  if (!repo) {
    throw new Error(`Unknown repository: ${repositoryId}`);
  }
  if (repo.worktrees.some((w) => w.id === worktree.id)) {
    throw new Error(`Worktree already exists: ${worktree.id}`);
  }
  repo.worktrees.push({
    id: worktree.id,
    name: worktree.name,
    path: worktree.path,
    labels: [...worktree.labels],
  });
  return base;
}

export function updateHostWorktree(
  existing: HostInventory | null | undefined,
  repositoryId: string,
  worktree: HostWorktree,
): HostInventory {
  const base = cloneInventory(existing);
  const repo = base.repositories.find((r) => r.id === repositoryId);
  if (!repo) {
    throw new Error(`Unknown repository: ${repositoryId}`);
  }
  const idx = repo.worktrees.findIndex((w) => w.id === worktree.id);
  if (idx < 0) {
    throw new Error(`Unknown worktree: ${worktree.id}`);
  }
  repo.worktrees[idx] = {
    id: worktree.id,
    name: worktree.name,
    path: worktree.path,
    labels: [...worktree.labels],
  };
  return base;
}

export function removeHostWorktree(
  existing: HostInventory | null | undefined,
  repositoryId: string,
  worktreeId: string,
): HostInventory {
  const base = cloneInventory(existing);
  const repo = base.repositories.find((r) => r.id === repositoryId);
  if (!repo) {
    throw new Error(`Unknown repository: ${repositoryId}`);
  }
  repo.worktrees = repo.worktrees.filter((w) => w.id !== worktreeId);
  return base;
}

/**
 * @deprecated Prefer upsertHostRepository + addHostWorktree so worktrees are explicit.
 * Kept for tests/examples: replaces repo and sets a single auto-path worktree.
 */
export function mergeHostRepository(
  existing: HostInventory | null | undefined,
  entry: {
    id: string;
    path: string;
    defaultBranch: string;
    worktreeId: string;
    worktreeName: string;
    labels?: string[];
  },
): HostInventory {
  let next = upsertHostRepository(existing, {
    id: entry.id,
    path: entry.path,
    defaultBranch: entry.defaultBranch,
  });
  // Replace worktrees entirely (legacy behavior).
  const repo = next.repositories.find((r) => r.id === entry.id)!;
  repo.worktrees = [
    {
      id: entry.worktreeId,
      name: entry.worktreeName,
      path: defaultWorktreePath(entry.path, entry.worktreeName),
      labels: entry.labels ?? ["echo"],
    },
  ];
  return next;
}

/** Empty host inventory for “add agent” before any repos are attached. */
export function emptyHostInventory(): HostInventory {
  return {
    repositories: [],
    commandProfiles: { ...DEFAULT_ECHO_PROFILE },
  };
}
