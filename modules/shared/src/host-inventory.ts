/** Pure helpers for agent host inventory (used by both control + agent UIs). */

export type HostWorktree = {
  id: string;
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

export const DEFAULT_ECHO_PROFILE = {
  "echo-prompt": { argv: ["echo"], appendPrompt: true },
} as const;

export function defaultWorktreePath(repoPath: string, worktreeId: string): string {
  return `${repoPath.replace(/\/$/, "")}/.worktrees/${worktreeId}`;
}

/** Merge or replace one host repo entry; seeds default profile if none. */
export function mergeHostRepository(
  existing: HostInventory | null | undefined,
  entry: {
    id: string;
    path: string;
    defaultBranch: string;
    worktreeId: string;
    labels?: string[];
  },
): HostInventory {
  const worktreePath = defaultWorktreePath(entry.path, entry.worktreeId);
  const base: HostInventory = {
    repositories: existing?.repositories ? [...existing.repositories] : [],
    commandProfiles:
      existing?.commandProfiles && Object.keys(existing.commandProfiles).length > 0
        ? { ...existing.commandProfiles }
        : { ...DEFAULT_ECHO_PROFILE },
  };
  base.repositories = base.repositories.filter((r) => r.id !== entry.id);
  base.repositories.push({
    id: entry.id,
    path: entry.path,
    defaultBranch: entry.defaultBranch,
    worktrees: [
      {
        id: entry.worktreeId,
        path: worktreePath,
        labels: entry.labels ?? ["echo"],
      },
    ],
  });
  return base;
}
